# 🚀 Agent Chat Pro

**三模式 AI 聊天客户端** — SSH 远程 · 云端 AI · 本机运行

一个面向 Windows 桌面的 Electron 应用：把「连着云上的 AI 服务商」「SSH 到远端机器跑 Claude Code」「本机跑 Claude Code」三种工作方式装进同一个界面，并围绕它长出了一整套周边——云办公沙箱、N2N 虚拟专网体检与一键部署、设备联动、开发面板、防破解构建管线等。

[![Version](https://img.shields.io/badge/version-3.42.0-blue.svg)]()
[![Platform](https://img.shields.io/badge/platform-Windows-green.svg)]()
[![Tests](https://img.shields.io/badge/tests-49%20files%20green-brightgreen.svg)]()

---

## ✨ 核心特性

### 🌐 三模式连接
- **SSH 远程** — 连接 NAS/服务器上的 Claude Code，远程开发；支持双卡槽（ssh-1/ssh-2）会话跟槽走、主机指纹信任管理、IP 漂移自动重定位（指纹当身份证）
- **云端 AI** — 无需本地 CLI，直连 AI 服务商聊天；支持功能调用（工具循环）、云上 plan 约定块
- **本机运行** — 使用本机 Claude Code / AtomCode daemon 引擎 / 自定义命令引擎

### 🤖 十家 AI 服务商 + 模型清单全量
智谱 AI · DeepSeek · Kimi · 豆包 · OpenAI · Gemini · Anthropic · Groq · 硅基流动 · 自定义中转。填写密钥后可一键「🔄 拉取」实时读官方模型列表，下拉框现拉现用；模型名支持手动填写，中转站兼容 one-api/new-api。

### 💬 现代聊天体验
- 思考过程折叠块标题带「字数 · ⏱ 耗时 · 🧠 档位」元信息（流式渐进收敛）
- 思考挡位调节（ECO/默认/轻度/中等/最高五挡，渐变轨道+最高挡彩蛋），按服务商/模型/工作模式独立记忆
- Agent plan 面板（TodoWrite 特化渲染 / ```plan 约定块），三模式全覆盖
- ask_user 选择题卡（AI 遇岔路弹卡点选，不再瞎猜）
- 智能滚动跟随、后台任务可切对话无缝衔接、token 财务口径计数、AI 复读检测折叠

### 🏋️ 云办公（云端 AI 带工具干活）
- 云端模式 function calling 工具循环：读写文件、跑命令、抓网页
- **本地 Docker 沙箱执行**（默认断网隔离、可临时联网、POSIX 越界护栏、stdin 流写入）
- 工作轮次上限可调（默认 25，最大 10000）

### 🔒 安全与防破解
- API 密钥 / SSH 密码 safeStorage 加密落盘
- 安装包防线：CSP、ASAR 完整性、fuse 校验、bytecode（.jsc）+ AES（.enc）双语混淆 fallback、JS 混淆（语句重排类变换永久禁用避免执行语义漂移）
- **混淆后模块加载冒烟**进构建管线：混淆产物逐模块 require 实测，炸就停在构建
- **TDZ 守门测试**：全模块作用域树扫描「声明后置」形态，防执行路径上的 ReferenceError
- Bridge Edition（独立阉割版产物线）：内置 Agent HTTP 桥，云端 AI 经 127.0.0.1 HTTP 桥与 SSH Agent 对话，带人工放行队列与限频

### 🧩 插件与周边
- **开发面板（可选插件）**：右侧实时观察 AI 正在编辑的文件（活动流、三态色点、窄条折叠），三模式全支持
- **N2N 体检 + 一键部署**：五项只读体检 + edge/TAP/PATH 自动补齐 + 公网入口连通检测（未配置一律跳过，不携带任何内建默认入口）
- **打印协议联动**（`agent-print://`，配合独立应用 Agent print）
- **设备联动**：经 SSH 向 Windows 目标机部署联动控件，自动处理共存隔离与嵌套自愈

---

## 📥 下载安装

前往 **Releases** 页面下载最新版安装包。

如果这个工具帮到了你，欢迎点一个 ⭐ **Star**，让更多人看到。

**系统要求**：Windows 10/11（64 位）

**安装步骤**：
1. 下载 `Agent Chat Pro-x.x.x-Setup.exe`（NSIS 向导安装）
2. 双击运行安装向导
3. 启动后选择连接方式（云端 / SSH / 本机）

> 说明：Releases 中的安装包经完整构建管线（混合签名指纹在 `dist/SHA256SUMS.txt` 随包交付）。

---

## 🚀 快速开始

### 云端 AI 零门槛
1. 启动 → 选择「云端 AI」模式
2. 服务商选「智谱 AI」→ [注册创建密钥](https://open.bigmodel.cn/user/apikey)
3. 粘贴密钥 → 点「🔄 拉取」刷模型列表 → 开始聊天 🎉

### SSH 远程
1. 选择「SSH 远程」模式
2. 填写主机地址、账号、密码（或密钥）
3. 连接后即可远程使用 Claude Code

### 本机模式
1. 选择「本机」模式，配置本机引擎（claude / AtomCode / 自定义命令）
2. 引擎就绪即可工作

---

## 🛠️ 从源码构建

```bash
npm install
npm test               # 全量回归（统一测试入口：全部 test-v3-*.cjs 版本级测试 + 8 个专项 test-*.cjs，串行跑完汇总）
npm run build:win:nsis # 构建 Windows NSIS 安装包
node scripts/build-pipeline.cjs bridge   # Bridge Edition（阉割版产物线）
```

- Node.js 20+，electron 35.x / electron-builder 26.x（锁版）
- 混淆体系说明：`scripts/obfuscate.cjs`（medium 名单模块混淆），`scripts/obf-smoke.cjs`（混淆后加载冒烟）
- 测试体系：每个大版本一份 `test-v3-x-y.cjs`，含真 HTTP / 真 IPC / vm 假 DOM 冒烟 / TDZ 扫描守门

---

## ❓ FAQ

<details>
<summary><b>这个软件是开源的吗？</b></summary>

不是。本仓库是**源码可见的专有软件**：源码仅用于审阅、学习与安全检验，未附开源许可证文档，未明确授予的权利一律保留。个人学习与自用不受限制，商用/分发需书面授权（详见文末「版权与授权」）。
</details>

<details>
<summary><b>软件免费吗？要花钱的地方在哪？</b></summary>

软件本体免费（Releases 下载安装即用）。聊天的花费取决于你的 AI 服务商：云端模式需要你自己申请 API 密钥（部分服务商提供免费模型或免费额度，其余按量计费）；SSH/本机模式跑的是你自己机器上的 Claude Code，费用由你的 AI 订阅或 API 决定。本项目不内嵌任何收费环节，也不抽成。
</details>

<details>
<summary><b>三种模式分别需要准备什么？</b></summary>

- **云端 AI**：只要一个服务商 API 密钥（任意一家即可），无需本地安装任何 CLI——填密钥→点「🔄 拉取」刷模型→开聊
- **SSH 远程**：一台开了 SSH 的远端机器（NAS/服务器/VPS），上面装有 Claude Code；填地址账号密码（或密钥）即可
- **本机运行**：本机装有 Claude Code（或 AtomCode 等 CLI）
</details>

<details>
<summary><b>我的密钥和聊天记录存在哪里？会外传吗？</b></summary>

API 密钥使用 Electron safeStorage **加密后落盘在你本机用户目录**，SSH 密码同样加密存储；聊天记录存在你本机本地数据库。程序自身没有上传渠道：云端模式把你点的消息发给你**自己选择的服务商 API**（受其隐私条款约束）；SSH 模式的对话只经过你自己的远端机器。渲染层 CSP 收窄为 `connect-src 'self'`，页面零外发请求。
</details>

<details>
<summary><b>「云办公」沙箱是什么？需要什么条件？</b></summary>

云端模式开启工具执行后，AI 可以读写文件、跑命令、抓网页。**本地 Docker 沙箱**把这些执行放进你 SSH 目标机（如 NAS）的一个隔离容器里：默认断网（`internal: true` 物理 isolation）、可临时联网、工作目录 POSIX 越界护栏。需要在远端机准备 Docker（`docker-compose.yml` 一键起容器，见内置镜像规格：node20 + python3 + 常用 CLI）。不开沙箱则退回一期本机执行形态。
</details>

<details>
<summary><b>支持哪些 AI 服务商？中转站能用吗？</b></summary>

内置十家：智谱 AI、DeepSeek、Kimi、豆包、OpenAI、Gemini、Anthropic、Groq、硅基流动 + 自定义。自定义兼容 OpenAI 格式的中转端点（one-api / new-api 等），手填 Base URL + 密钥 + 模型名即可。各家清单随版本更新，也可点「🔄 拉取」实时读你密钥能用的全部模型。
</details>

<details>
<summary><b>换电脑 / 重装系统，配置和聊天记录怎么迁移？</b></summary>

用户数据在 Electron 用户目录（聊天记录库 / settings.json / safeStorage 密钥库），整体拷贝用户目录即可迁移。⚠ safeStorage 与系统账户绑定，**密钥直接拷贝到另一台机器解不出**——迁移后请在设置里重新填一次 API 密钥与 SSH 凭证。
</details>

<details>
<summary><b>N2N「体检/一键部署」是干什么的？为什么部署要管理员权限？</b></summary>

用于把 Windows 机器经虚拟专网接入你的远端环境（配合 SSH 模式远程办公）：体检五项只读检测（TAP 驱动/edge 工具/路径/公网入口连通性），一键部署自动装 TAP 驱动、解压工具包、写 PATH 并起 edge。TAP 网卡与系统 PATH 写入是系统级操作，需要一次管理员授权（UAC 弹窗），部署完成无需重启即可直连。项目不带任何内建默认入口，公网入口按你自己的环境填写。
</details>

<details>
<summary><b>启动很慢 / 被杀毒软件拦截？</b></summary>

启动自检会做安装包完整性校验（ASAR 完整性 + fuse 校验），正常情况毫秒级。若被杀软误报，请将安装目录加入白名单（安装包未做商业代码签名——签名需要证书，当前为已知限制）。安装体以 Releases 说明为准。
</details>

<details>
<summary><b>为什么 Agent Chat Pro 后面得带个「Pro」？明明没发布过普通版？</b></summary>

普通版不是没有过——它的兄弟版本就是 **Agent Orbit（AO）**。两个软件共用同一个起点（早期轻量聊天客户端 Agent NAS Chat），从那里分成两条平行线：AO 走轻量取向（Windows + Android 双端，把 Claude Code 变成即时通讯式体验，独立迭代至今）；本仓库这条线几经更名（Claude Code Connect Chat）后定格为 Agent Chat Pro——「Pro」就这么来的：它是和普通版兄弟并列的名字，不是付费档位。两条线独立迭代、互为参考（AO 的模块化架构、模型配置等经验也被这条线吸收）。AO 不在本仓库提供下载，所以你在这里见到的只有带 Pro 的这一个包。
</details>

<details>
<summary><b>遇到 bug / 想提需求？</b></summary>

在仓库提 Issue 即可，尽量附：系统版本、连接模式（云端/SSH/本机）、复现步骤与报错原文。
</details>

---

## 📄 第三方组件致谢

| 组件 | 用途 | 来源 |
|---|---|---|
| [Electron](https://www.electronjs.org/) | 桌面壳 | MIT License |
| [n2n](https://github.com/ntop/n2n) | 虚拟专网 | GPL/Apache 双许可（ntop 项目） |
| n2n Windows x64 静态编译 r1255 | edge/supernode Windows 构建 | 社区编译（by heiye），依 n2n 上游许可条款随包分发；商用/再分发前请自行核验上游许可与编号 |
| [tap-windows 9.21.2](https://github.com/OpenVPN/tap-windows) | TAP 虚拟网卡驱动 | OpenVPN 项目（随安装包附带） |
| [electron-builder](https://www.electron.build/) | 打包 | MIT License |
| 服务商 API | 智谱/DeepSeek/Anthropic/OpenAI/… | 各服务条款 |

---

## 📋 版本概览（关键里程碑）

| 版本 | 内容 |
|------|------|
| v0.1.11 | Agent NAS Chat 基线 |
| v3.0.0 | 更名 Agent Chat Pro，Orbit 特性移植 + UI 改造 |
| v3.4.0 | Anthropic + Groq 服务商、HTTP/SOCKS5 代理 |
| v3.7 ~ v3.12 | SDK 桥接入、Tier-2 迁移、防破解体系、N2N 接入+工具包 |
| v3.13 ~ v3.16 | 本机多引擎、云端工具执行、交互优化、安全加固、双控件共存隔离 |
| v3.17 ~ v3.20 | IP 追踪产品化、模型页 + SSH 双卡槽、高级设置多 CLI 适配器、Agent plan 面板 |
| v3.21 ~ v3.23 | 云端模型清单三件套、云办公 Docker 沙箱、N2N 体检 + 一键部署 |
| v3.24.x | 思考挡位/元信息、ask_user、开发面板及插件化 |

详细变更见各 Release 说明。

---

## ⚠️ 免责声明

本软件仅供学习和个人使用。使用本软件即表示您同意：

- 本软件按"原样"提供，不作任何担保
- 对使用本软件造成的任何损失，作者不承担责任
- 请遵守您所在地区的法律法规
- 请遵守各 AI 服务商的使用条款

**关于默认占位值**：本仓库为源码可见的专有软件发布版本，代码与工具包文档中涉及超级节点地址、社区名、内网地址等处一律使用占位值（如 `entry.example.org`、`demo-community`、`10.66.x.x`），不携带任何部署者自己的真实环境信息。

---

## ©️ 版权与授权

Copyright © 2026 Jiang. **保留所有权利（All Rights Reserved）**。

本软件为**专有软件（Proprietary Software）**，不是开源软件：

- 仓库公开**源码仅用于审阅、学习与安全检验**，作者未附开源许可证文档
- **未明确授予的权利一律保留**：未经作者书面授权，不得复制、分发、修改、再打包、去除混淆/水印或将本项目（含源码与安装包）用于商业用途
- 个人学习与自用不受上述限制；如需合作、分发或商用授权，请通过仓库（Issue）联系作者
- 第三方依赖各自遵从其原始许可（见上方「第三方组件致谢」），本项目对其的引入方式符合相应条款