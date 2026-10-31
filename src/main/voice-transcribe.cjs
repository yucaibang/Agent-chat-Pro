"use strict";
// v3.36.0 输入栏「听说」：麦克风语音输入（录音 → 云端 ASR 转录 → 文字插入输入框）。
// 调研结论（L2，2026-10-31）：Electron 内置 webkitSpeechRecognition 依赖 Chrome 专属云服务，
// 在 Electron 里从未真正可用（electron/electron#46143 维护者原话 "it never worked, the remote
// transcription relies on Google servers"），故走「渲染层录 WAV → 主进程转发云端转录端点」。
// 复用连接设置已保存的云端密钥（getCloudAiConfig），零新增配置：
// - zhipu      POST {baseURL}/audio/transcriptions  model=glm-asr-2512            （官方限 .wav/.mp3 ≤25MB ≤30 秒）
// - siliconflow 同上                                 model=FunAudioLLM/SenseVoiceSmall
// - openai     同上                                  model=whisper-1
// - groq       同上                                  model=whisper-large-v3
// 响应统一 {text}。其余服务商（deepseek/kimi/doubao/gemini/anthropic/custom）无公开转录端点，明确提示引导。

const DEFAULT_TIMEOUT_MS = 60000;

// 四家 OpenAI 兼容转录端点共用的 model 名（其余家暂无公开兼容端点）
const ASR_MODELS = {
  zhipu: "glm-asr-2512",
  siliconflow: "FunAudioLLM/SenseVoiceSmall",
  openai: "whisper-1",
  groq: "whisper-large-v3",
};

// 各家官方时长上限（秒）。渲染层据此自动截止录音，主进程再校验一次。
const ASR_LIMIT_SECONDS = {
  zhipu: 30,        // 官方文档：音频时长 ≤ 30 秒
  siliconflow: 3600,
  openai: 1500,
  groq: 3000,
};

// 渲染层点「听说」前先问一次：当前云端服务商支持转录吗/最长说多久
function asrInfoFor(provider) {
  const key = String(provider || "").trim();
  const model = ASR_MODELS[key];
  if (!model) {
    return {
      supported: false,
      reason: "该服务商没有公开的语音识别接口。语音输入目前支持：智谱 / 硅基流动 / OpenAI / Groq——在连接设置切换云端服务商即可使用。",
    };
  }
  return { supported: true, model, maxSeconds: Math.min(ASR_LIMIT_SECONDS[key] || 60, 300) };
}

function voiceChineseErrorForStatus(status) {
  if (status === 400) return "请求被拒绝（400）：录音格式不合规（需 wav/mp3），或录音时长超出该服务商上限";
  if (status === 401 || status === 403) return "密钥无效或无权限调用语音识别";
  if (status === 404) return "服务商未提供转录接口（404），请确认 API 地址正确";
  if (status === 413) return "录音过大（413），请缩短时长后重试";
  if (status === 429) return "请求过于频繁（429），稍后再试";
  return `请求失败（HTTP ${status}）`;
}

// 渲染层已把麦克风采成 16kHz 16bit 单声道 WAV 的 base64，主进程只负责发 multipart 转录请求。
// payload: { audioBase64, seconds }；密钥/服务商/地址一律以连接设置已保存云配置为准（读 getCloudAiConfig 由调用方注入，
//   与 cloud:fetch-models「main.cjs 负责拼接已存密钥」同款分工，本模块不触碰加密存储）。
async function transcribeAudio(config = {}, payload = {}, fetchImpl = globalThis.fetch) {
  const info = asrInfoFor(config.provider);
  if (!info.supported) {
    return { ok: false, unsupported: true, reason: info.reason };
  }
  const apiKey = String(config.apiKey || "").trim();
  const baseUrl = String(config.baseURL || config.baseUrl || "").trim().replace(/\/+$/, "");
  const audioBase64 = String(payload.audioBase64 || "");
  const seconds = Number(payload.seconds) || 0;
  if (!audioBase64) {
    return { ok: false, reason: "没有收到录音数据，请重试", };
  }
  if (!apiKey) {
    return { ok: false, noKey: true, reason: "尚未在连接设置保存云端 API Key：先在「连接设置 → 云端 AI」保存密钥，再用听说。" };
  }
  if (!baseUrl) {
    return { ok: false, reason: "云端 API 地址为空，请在连接设置补全后重试" };
  }
  if (seconds > info.maxSeconds + 1) {
    return { ok: false, reason: `录音 ${Math.round(seconds)} 秒超出该服务商上限（${info.maxSeconds} 秒），请分几段说` };
  }

  const url = `${baseUrl}/audio/transcriptions`;
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(audioBase64, "base64")], { type: "audio/wav" }), "voice.wav");
  form.append("model", info.model);
  if (config.provider === "zhipu") form.append("stream", "false");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form, signal: controller.signal });
    const text = await response.text();
    if (!response.ok) {
      let detail = voiceChineseErrorForStatus(response.status);
      try {
        const parsed = JSON.parse(text);
        const message = parsed?.error?.message || parsed?.message || "";
        if (message) detail = `${detail}——${String(message).slice(0, 120)}`;
      } catch { /* 保留通用文案 */ }
      return { ok: false, status: response.status, reason: detail };
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, reason: "响应不是合法 JSON，请检查 API 地址是否指向正确服务商" };
    }
    const transcribed = String(parsed?.text || "").trim();
    if (!transcribed) {
      return { ok: false, reason: "没有识别出文字（可能太短或太吵），请靠近麦克风再说一次" };
    }
    return { ok: true, text: transcribed, seconds: Math.round(seconds * 10) / 10 };
  } catch (error) {
    const aborted = error?.name === "AbortError";
    return { ok: false, reason: aborted ? `请求超时（${Math.round(DEFAULT_TIMEOUT_MS / 1000)} 秒）` : `网络错误：${error?.message || "未知"}` };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { transcribeAudio, asrInfoFor, ASR_MODELS, ASR_LIMIT_SECONDS };