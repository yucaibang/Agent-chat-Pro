"use strict";

/**
 * 产品形态开关（编译期注入）—— 阉割机制核心（v3.21.2 后首个独立产物：Bridge Edition）
 *
 * 仓库内提交的默认内容 = 主版（全功能，默认形态）。
 * 构建流水线（scripts/build-pipeline.cjs）按构建目标在打包前整文件改写本文件：
 *   - 目标 "nsis" / "portable" → 主版形态（当前提交内容，等幂重写）
 *   - 目标 "bridge"           → Bridge 形态（阉割：无设备联动/打印联动/本机引擎/彩蛋，增 Agent HTTP 桥）
 * 步骤 5 还原用 git checkout HEAD（与本管线其余文件同一机制——构建前必须先提交，铁律）。
 *
 * 主进程运行时读本对象做功能门控；渲染层经 IPC `app:edition` 获取同一份对象
 * （preload 处于 sandbox:true，无法直接 require 本文件）。
 */

const MAIN_EDITION = {
  edition: "main",
  productName: "Agent Chat Pro",
  gates: {
    deviceLink: true,   // 设备联动（联动控件 / IP 追踪 / 共存扫描）
    printLink: true,    // 打印联动（v3.16.1，Agent print 生态闭环）
    localEngines: true, // 本机模式多引擎（v3.13.0，atomcode / custom）
    easterEgg: true,    // v3.15.8 关于页跳跳龙彩蛋
    agentBridge: false, // Agent HTTP 桥（Cloud AI 接入口——阉割版专属，主版关闭）
    cloudChat: true,    // 云端 AI 模式
    cacheClean: true,   // 缓存清理（v3.10.0）
    signalLights: true  // 信号灯带
  }
};

const BRIDGE_EDITION = {
  edition: "bridge",
  productName: "Agent Chat Pro Bridge",
  gates: {
    deviceLink: false,
    printLink: false,
    localEngines: false,
    easterEgg: false,
    agentBridge: true,
    cloudChat: true,
    cacheClean: true,
    signalLights: true
  }
};

function editionFor(edition) {
  return edition === "bridge" ? BRIDGE_EDITION : MAIN_EDITION;
}

module.exports = {
  edition: "main",
  productName: "Agent Chat Pro",
  gates: { ...MAIN_EDITION.gates },
  MAIN_EDITION,
  BRIDGE_EDITION,
  editionFor
};