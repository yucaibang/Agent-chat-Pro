<div align="center">

# 🚀 Agent Chat Pro

**内网/外网双模式 SSH 远程 AI 聊天客户端**

[![Version](https://img.shields.io/badge/version-0.7.4-blue.svg)](https://github.com/your-username/Agent-Chat-Pro)
[![Platform](https://img.shields.io/badge/platform-Windows-green.svg)](https://github.com/your-username/Agent-Chat-Pro)
[![License](https://img.shields.io/badge/license-MIT-orange.svg)](LICENSE)

Electron 桌面应用 · 通过 SSH 或穿透隧道连接 NAS/服务器上的 AI CLI

[功能特性](#-功能特性) · [下载安装](#-下载安装) · [配置说明](#-配置说明) · [构建指南](#-构建指南)

</div>

---

## 🌟 功能特性

### 🌐 双模式网络

| 模式 | 传输方式 | 说明 |
|------|----------|------|
| **内网模式** | SSH 直连 | 局域网内最低延迟、最稳定的连接方式 |
| **外网模式** | FRP 穿透 | 通过 FRP 服务器端口映射远程连接 |
| | DERP 中继 | 通过 TCP 中继服务器转发 SSH 会话 |
| | P2P 打洞 | STUN 发现公网端点后直连（锥形 NAT） |
| | N2N 虚拟网 | 启动本地 edge 进程组建虚拟局域网 |
| | 自动降级 | P2P → DERP → FRP 逐级回退，自动选择可用链路 |

### 🎯 工作模式

| 模式 | 说明 | 适用场景 |
|------|------|----------|
| ⚡ 自动化 | 跳过权限确认、低 token 上限 | 批量执行、无人值守任务 |
| 🛡 常规 | 标准确认流程、高 token 上限 | 日常对话、代码审查 |
| 🌿 ECO 节能 | 严格权限、最低 token | 快速问答、节省额度 |

支持自定义模式 + JSON 导入/导出，每个模式可配置 system prompt、thinking level、hallucination control、energy priority。

### 📊 实时监控

- 连接延迟实时显示（优秀/良好/一般/差 四级评分）
- 网络状态指示器（内网直连/FRP/DERP/P2P/N2N）
- 30s 心跳保活 + 连续 3 次失败自动重连

### 🔒 安全设计

- SSH 主机指纹 SHA256 验证（首次连接询问 + 已知主机校验）
- 外网模式访问密码保护
- FRP/DERP/P2P/N2N 各自独立参数配置
- 联动控件（Windows SSH 受控端）仅允许指定来源 IP 访问

---

## 📥 下载安装

> **Windows 安装包**（推荐）

[下载最新版 Agent Chat Pro-Setup.exe](https://github.com/your-username/Agent-Chat-Pro/releases/latest)

安装向导包含中英双语免责声明，需同意后方可继续安装。

**系统要求**：Windows 10/11 · Node.js ≥ 18（服务端）

---

## ⚙️ 配置说明

### SSH 直连（内网模式）

| 参数 | 说明 | 默认值 |
|------|------|--------|
| Host | NAS/服务器 IP | — |
| Port | SSH 端口 | 22 |
| Username | SSH 用户名 | — |
| Password | SSH 密码 | — |

### FRP 穿透（外网模式）

| 参数 | 说明 | 默认值 |
|------|------|--------|
| 服务器地址 | FRP 服务器域名/IP | — |
| 服务器端口 | FRP 服务端端口 | 7000 |
| Token | FRP 认证令牌 | — |
| 远程端口 | NAS SSH 映射到 FRP 的端口 | 6000 |

> 前提：NAS 端已运行 frpc，将 SSH 端口映射到 FRP 服务器。

### DERP / P2P / N2N

各方案的详细配置参数见应用内「网络设置」折叠区。

---

## 🛠 构建指南

### 前置条件

- Node.js ≥ 18
- npm ≥ 8
- Windows 目标机器用于测试

### 构建

```bash
# 克隆仓库
git clone https://github.com/your-username/Agent-Chat-Pro.git
cd Agent-Chat-Pro

# 安装依赖
npm install
cd src/bridge && npm install && cd ../..

# 构建 NSIS 安装包
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npx electron-builder --win nsis --x64 -c.npmRebuild=false
```

产出物：`dist/Agent Chat Pro-{version}-Setup.exe`

### ⚠️ asar 打包注意

子目录间的 `require()` 必须带 `.cjs` 扩展名：

```js
// ❌ asar 里找不到
const { Transport } = require("./transport-base");

// ✅ 正确
const { Transport } = require("./transport-base.cjs");
```

---

## 🏗️ 项目架构

```
Agent-Chat-Pro/
├── build/                          # 应用图标 + 免责声明
├── src/
│   ├── main/
│   │   ├── main.cjs                # 主进程入口
│   │   ├── settings.cjs            # 设置管理（含网络/模式配置校验）
│   │   ├── ssh.cjs                 # SSH 连接（超时保护+指数退避重连）
│   │   ├── device-control.cjs      # Windows SSH 联动控件安装
│   │   ├── network/                # 网络传输层（可插拔架构）
│   │   │   ├── transport-base.cjs  #   Transport 抽象基类
│   │   │   ├── ssh-direct.cjs      #   SSH 直连
│   │   │   ├── frp-tunnel.cjs      #   FRP 穿透
│   │   │   ├── derp-relay.cjs      #   DERP 中继
│   │   │   ├── p2p-nat.cjs         #   P2P 打洞
│   │   │   ├── n2n-mesh.cjs        #   N2N 虚拟局域网
│   │   │   ├── network-manager.cjs #   网络管理器（状态机+降级+心跳）
│   │   │   └── latency-monitor.cjs #   延迟监控+质量评分
│   │   └── modes/                  # 工作模式引擎
│   │       ├── mode-defaults.cjs   #   内置三模式定义
│   │       ├── mode-manager.cjs    #   CRUD + 导入导出
│   │       └── mode-params.cjs    #   参数映射
│   ├── renderer/
│   │   ├── index.html              # UI
│   │   ├── renderer.js             # 渲染逻辑
│   │   └── styles.css              # 暗色主题样式
│   ├── bridge/
│   │   └── agent-sdk-bridge.mjs    # AI CLI Bridge
│   └── device-control/
│       └── device-control.ps1      # Windows 联动安装脚本
└── package.json
```

### 传输层设计

所有网络方案实现统一的 `Transport` 接口：

```
connect(config, onUnknownHost, onLog) → Promise<void>
disconnect() → Promise<void>
exec(command, options) → Promise<{code, stdout, stderr}>
ping() → Promise<{latencyMs, jitter, mode}>
getStatus() → {state, mode, type, latencyMs, detail}
onStatusChange(callback) → unsubscribeFunction
```

`NetworkManager` 根据配置选取 Transport 实例，外网模式下自动降级：**P2P → DERP → FRP**。

---

## 📋 版本历史

| 版本 | 日期 | 说明 |
|------|------|------|
| v0.7.4 | 2026-08-19 | NSIS免责声明页 + device-control/bridge打包修复 |
| v0.7.3 | 2026-08-19 | asar require路径.cjs扩展名修复 |
| v0.7.2 | 2026-08-19 | 各Transport内置_friendlyError()错误分级 |
| v0.7.1 | 2026-08-18 | 品牌更名 Agent NAS Chat → Agent Chat Pro |
| v0.7.0 | 2026-08-18 | 模式选择器 UI |
| v0.6.0 | 2026-08-18 | 工作模式引擎（三内置模式+CRUD+导入导出） |
| v0.5.0 | 2026-08-17 | DERP/P2P/N2N 传输插件 |
| v0.4.0 | 2026-08-17 | FRP 穿透插件 |
| v0.3.0 | 2026-08-16 | 前端网络设置 UI |
| v0.2.0 | 2026-08-16 | 网络层核心（Transport基类+SSH直连+状态机） |
| v0.1.2 | 2026-08-15 | Bug修复（ESM/SFTP/重连/Bridge轮询） |
| v0.1.1 | 2026-08-15 | 基线（Agent NAS Chat v0.1.11 解包源码） |

---

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

## 📄 许可证

[MIT License](LICENSE)

---

<div align="center">

**Agent Chat Pro** · 让 AI 触手可及，无论远近

</div>