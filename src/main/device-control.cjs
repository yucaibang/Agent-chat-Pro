"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ACCOUNT_NAME = "ClaudeAgentControl";
const FIREWALL_RULE = "ClaudeNAS-Agent-Control";
const STATE_FOLDER = "ClaudeNasAgent";

function validatePublicKey(value) {
  const key = String(value || "").trim();
  if (!/^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}(?: .*)?$/.test(key)) {
    throw new Error("管理端 SSH 公钥格式无效。");
  }
  return key;
}

function validateSourceAddress(value) {
  const source = String(value || "").trim();
  const ipv4 = "(?:25[0-5]|2[0-4]\\d|1?\\d?\\d)";
  const ipv4Pattern = new RegExp(`^${ipv4}(?:\\.${ipv4}){3}(?:/(?:[0-9]|[12]\\d|3[0-2]))?$`);
  const ipv6Pattern = /^[0-9a-fA-F:]+(?:\/\d{1,3})?$/;
  if (["0.0.0.0", "0.0.0.0/0", "::", "::/0"].includes(source)) {
    throw new Error("不允许把联动 SSH 开放给所有网络，请填写 NAS 的 IP 或受控网段。");
  }
  if (source !== "LocalSubnet" && !ipv4Pattern.test(source) && !ipv6Pattern.test(source)) {
    throw new Error("允许来源必须是 NAS 的 IP、CIDR 网段或 LocalSubnet。");
  }
  return source;
}

function validateTargetAddress(value) {
  const target = validateSourceAddress(value);
  if (target === "LocalSubnet" || target.includes("/")) throw new Error("本机被控地址必须是一台电脑的具体 IP，不能填写网段。");
  return target;
}

function validateTargetPort(value) {
  const port = Number(value || 22);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SSH 端口必须是 1 到 65535 的整数。");
  return port;
}

function statePath() {
  const programData = process.env.ProgramData || "C:\\ProgramData";
  return path.join(programData, STATE_FOLDER, "install-state.json");
}

function localAddresses() {
  const result = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const item of entries || []) {
      if (item.internal || item.family !== "IPv4" || item.address.startsWith("169.254.")) continue;
      result.push(item.address);
    }
  }
  return [...new Set(result)];
}

function preferredAddress(sourceAddress, addresses = localAddresses()) {
  const source = String(sourceAddress || "");
  const prefix = source.match(/^(\d+\.\d+\.\d+)\./)?.[1];
  return (prefix && addresses.find((address) => address.startsWith(prefix + "."))) || addresses[0] || "";
}

function getDeviceControlStatus() {
  if (process.platform !== "win32") {
    return { supported: false, installed: false, platform: process.platform, reason: "联动控件仅支持 Windows 10/11。" };
  }
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath(), "utf8")); } catch {}
  const windowsDirectory = process.env.WINDIR || "C:\\Windows";
  const opensshPath = path.join(windowsDirectory, "System32", "OpenSSH", "sshd.exe");
  return {
    supported: true,
    installed: Boolean(state.installed),
    serviceRunning: serviceRunning("sshd"),
    openSshAvailable: fs.existsSync(opensshPath),
    account: state.account || ACCOUNT_NAME,
    sourceAddress: state.sourceAddress || "",
    permissionMode: state.permissionMode || "administrator",
    deviceId: state.deviceId || "",
    managementKeyPath: state.managementKeyPath || "",
    targetAddress: state.targetAddress || "",
    targetPort: state.targetPort || 22,
    hostname: os.hostname(),
    localAddresses: localAddresses(),
    windowsRelease: os.release(),
    existingBroadFirewallWarning: Boolean(state.existingBroadFirewallWarning)
  };
}

function serviceRunning(name) {
  try {
    const { spawnSync } = require("child_process");
    const result = spawnSync("sc.exe", ["query", name], { encoding: "utf8", windowsHide: true });
    return result.status === 0 && /STATE\s*:\s*4\s+RUNNING/i.test(result.stdout || "");
  } catch { return false; }
}

async function installDeviceControl(input) {
  if (process.platform !== "win32") throw new Error("联动控件只能安装在 Windows 10/11。 ");
  const config = {
    action: "Install",
    publicKey: validatePublicKey(input.publicKey),
    sourceAddress: validateSourceAddress(input.sourceAddress),
    targetAddress: validateTargetAddress(input.targetAddress),
    targetPort: validateTargetPort(input.targetPort),
    permissionMode: input.permissionMode === "standard" ? "standard" : "administrator",
    deviceId: String(input.deviceId || "").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 80),
    managementKeyPath: String(input.managementKeyPath || "").slice(0, 500)
  };
  if (!config.deviceId) throw new Error("无法创建联动设备编号。");
  await runElevated(config);
  const status = getDeviceControlStatus();
  if (!status.installed || !status.serviceRunning) throw new Error("联动控件没有成功启动，请打开诊断日志查看原因。");
  return status;
}

async function uninstallDeviceControl() {
  if (process.platform !== "win32") throw new Error("联动控件只能在 Windows 上卸载。");
  await runElevated({ action: "Uninstall" });
  return getDeviceControlStatus();
}

function runElevated(config) {
  return new Promise((resolve, reject) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "claude-nas-agent-"));
    const configPath = path.join(temporary, "config.json");
    const resultPath = path.join(temporary, "result.txt");
    const scriptPath = installerScriptPath();
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
    const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
    const command = [
      `$process = Start-Process -FilePath 'powershell.exe'`,
      `-ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',${quote(scriptPath)},'-ConfigPath',${quote(configPath)},'-ResultPath',${quote(resultPath)})`,
      "-Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $process.ExitCode"
    ].join(" ");
    const child = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (data) => { stderr += data.toString("utf8"); });
    child.once("error", finishError);
    child.once("close", (code) => {
      let elevatedError = "";
      try { elevatedError = fs.readFileSync(resultPath, "utf8").trim(); } catch {}
      cleanup();
      if (code === 0) resolve(true);
      else if (code === 1223 || /canceled by the user/i.test(stderr)) reject(new Error("已取消 Windows 管理员授权，未安装联动控件。"));
      else reject(new Error(`联动控件操作失败（代码 ${formatExitCode(code)}）。${localizedInstallerError(elevatedError || stderr.trim())}`));
    });
    function finishError(error) { cleanup(); reject(new Error("无法启动 Windows 安装程序：" + error.message)); }
    function cleanup() { try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {} }
  });
}

function installerScriptPath() {
  const { app } = require("electron");
  const packaged = path.join(process.resourcesPath || "", "device-control", "device-control.ps1");
  if (app?.isPackaged) {
    if (!fs.existsSync(packaged)) throw new Error("安装包缺少联动控件资源，请重新下载完整程序。");
    return packaged;
  }
  return path.join(__dirname, "device-control.ps1");
}

function formatExitCode(code) {
  if (!Number.isInteger(code)) return "未知";
  const unsigned = code >>> 0;
  return `${code} / 0x${unsigned.toString(16).toUpperCase().padStart(8, "0")}`;
}

function localizedInstallerError(message) {
  const detail = String(message || "").trim();
  const stageCode = detail.match(/^\[([^\]]+)\]/)?.[1] || "";
  const stages = {
    "read-installer-config": "读取安装配置",
    "check-administrator": "确认管理员权限",
    "check-windows-version": "检查 Windows 版本",
    "check-openssh-server": "检查 OpenSSH Server",
    "install-openssh-server": "安装 OpenSSH Server",
    "check-openssh-runtime": "检查 OpenSSH 运行库",
    "preserve-passwordless-autologon": "保护已有的无密码自动登录",
    "create-control-account": "创建联动专用账号",
    "write-control-key": "写入联动公钥并设置权限",
    "validate-sshd-config": "配置并校验 sshd",
    "configure-firewall": "配置来源受限的防火墙规则",
    "start-sshd-service": "启动 OpenSSH 服务",
    "save-install-state": "保存联动安装状态"
  };
  const stage = stages[stageCode] ? `失败阶段：${stages[stageCode]}。` : "";
  if (/0xC0000139|versions do not match/i.test(detail)) {
    return "Windows 自带的 OpenSSH 客户端、服务端与加密库版本不一致。请先在“设置 → 更新和安全 → Windows 更新”中安装最新累计更新并重启，再重新安装；这与 Windows 是否激活无关，现有 SSH 配置未被修改。";
  }
  if (/0xC000013A|3221225786/i.test(detail)) return "Windows 联动安装程序被关闭或中断，安装没有完成。请重新点击安装，确认管理员授权后留在软件窗口等待结果，不要关闭弹出的进程。";
  if (/0x800f0954/i.test(detail)) return "Windows 可选功能安装被公司更新策略或 WSUS 阻止（0x800F0954）。请让管理员允许从 Windows Update 获取 OpenSSH Server，或由公司软件分发系统安装后重试。";
  if (/0x800f081f|source files could not be found/i.test(detail)) return "Windows 找不到 OpenSSH Server 的系统组件源（0x800F081F）。请先安装最新累计更新并修复 Windows 组件存储后重试。";
  if (/administrator permission|access.*denied|拒绝访问/i.test(detail)) return "Windows 管理员授权不足或被安全策略拒绝。请确认 UAC 选择“是”，并让公司管理员检查应用控制策略。";
  if (/OpenSSH Server is not available/i.test(detail)) return "这台 Windows 没有可用的 OpenSSH Server 可选组件。请先完成 Windows 更新，再重试安装联动控件。";
  if (/Failed to set permissions/i.test(detail)) return "无法为联动专用密钥目录设置安全权限，未开放 SSH 控制。请让管理员检查 ProgramData 权限或终端安全软件拦截记录。";
  return stage + (detail || "请打开诊断日志查看原因。");
}

module.exports = {
  ACCOUNT_NAME,
  FIREWALL_RULE,
  formatExitCode,
  getDeviceControlStatus,
  installDeviceControl,
  localizedInstallerError,
  localAddresses,
  preferredAddress,
  uninstallDeviceControl,
  validatePublicKey,
  validateSourceAddress,
  validateTargetAddress,
  validateTargetPort
};
