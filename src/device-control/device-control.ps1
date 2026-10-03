param(
  [Parameter(Mandatory = $true)][string]$ConfigPath,
  [Parameter(Mandatory = $true)][string]$ResultPath
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$agentRoot = Join-Path $env:ProgramData "AgentChatProAgent"
$statePath = Join-Path $agentRoot "install-state.json"
$sshdConfig = Join-Path $env:ProgramData "ssh\sshd_config"
$markerStart = "# BEGIN AGENT CHAT PRO CONTROL"
$markerEnd = "# END AGENT CHAT PRO CONTROL"
$accountName = "AgentChatProControl"
$firewallRule = "AgentChatPro-Agent-Control"

# ── 共存隔离（v3.16.2）：同机可能并存另一套 Agent 联动控件（Agent Orbit / Claude NAS 系）。
# 铁律：本脚本永远只触碰自家资源；对方 install-state.json 在用（installed=true）时，一个字节都不动。
# 仅当对方无人认领（无 state 或 installed!=true）时，卸载流程才可选清理其遗留。
$managedFamilies = [ordered]@{
  "agent-chat-pro" = [ordered]@{ folder = "AgentChatProAgent"; account = "AgentChatProControl"; firewallRule = "AgentChatPro-Agent-Control"; markerFamily = "AGENT CHAT PRO CONTROL" }
  "claude-nas-line" = [ordered]@{ folder = "ClaudeNasAgent"; account = "ClaudeAgentControl"; firewallRule = "ClaudeNAS-Agent-Control"; markerFamily = "CLAUDE NAS AGENT CONTROL"; listenerMarkerFamily = "CLAUDE NAS AGENT LISTENER" }
}

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Windows administrator permission is required."
  }
}

function Get-OpenSshCapability {
  Get-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0"
}

function Get-OpenSshExecutable {
  $candidates = @(
    (Join-Path $env:ProgramFiles "OpenSSH\sshd.exe"),
    (Join-Path $env:WINDIR "System32\OpenSSH\sshd.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  return $null
}

function Assert-OpenSshRuntime {
  $sshdExe = Get-OpenSshExecutable
  if (-not $sshdExe) { throw "OpenSSH Server executable was not installed correctly." }
  $probe = Start-Process -FilePath $sshdExe -ArgumentList "-V" -WindowStyle Hidden -Wait -PassThru
  if ($probe.ExitCode -eq -1073741511 -or ([uint32]$probe.ExitCode) -eq 3221225785) {
    throw "Windows OpenSSH Client, Server, and libcrypto.dll versions do not match (0xC0000139). Install the latest Windows cumulative update, then retry. The existing SSH configuration was not changed."
  }
}

function Assert-SshdConfig {
  param([Parameter(Mandatory = $true)][string]$ExpectedAuthorizedKeysFile)
  $sshdExe = Get-OpenSshExecutable
  $errorPath = Join-Path $env:TEMP ("agent-chat-pro-sshd-" + [Guid]::NewGuid().ToString("N") + ".log")
  try {
    $check = Start-Process -FilePath $sshdExe -ArgumentList @("-t", "-f", $sshdConfig) -WindowStyle Hidden -Wait -PassThru -RedirectStandardError $errorPath
    if ($check.ExitCode -ne 0) {
      $detail = if (Test-Path $errorPath) { (Get-Content -Raw -LiteralPath $errorPath).Trim() } else { "" }
      if (-not $detail) { $detail = "exit code $($check.ExitCode)" }
      throw "OpenSSH rejected the generated configuration: $detail"
    }
    $configured = (Get-Content -Raw -LiteralPath $sshdConfig).Replace("\", "/")
    $expected = $ExpectedAuthorizedKeysFile.Replace("\", "/")
    $blockPattern = "(?ims)^" + [regex]::Escape($markerStart) + "\s*$.*?^Match\s+User\s+agentchatprocontrol\s*$.*?^\s*PasswordAuthentication\s+no\s*$.*?^\s*AuthorizedKeysFile\s+" + [regex]::Escape($expected) + "\s*$.*?^" + [regex]::Escape($markerEnd) + "\s*$"
    if ($configured -notmatch $blockPattern) {
      throw "The dedicated OpenSSH Match block is missing or does not reference the expected authorized_keys file."
    }
  } finally {
    Remove-Item -LiteralPath $errorPath -Force -ErrorAction SilentlyContinue
  }
}

function Remove-AgentBlock([string]$content) {
  $pattern = "(?ms)^" + [regex]::Escape($markerStart) + ".*?^" + [regex]::Escape($markerEnd) + "\s*"
  return [regex]::Replace($content, $pattern, "")
}

# ── 共存扫描（v3.16.2）───────────────────────────────────────────────
# 扫描 sshd_config 中全部 Agent marker 区间（字符 offset 定位），供冲突判定与安全插入共用。

function Get-AgentMarkerRegions([string]$content) {
  $regions = @()
  $beginRegex = '(?m)^\s*#\s*BEGIN\s+([A-Z][A-Z ]+?)\s+(CONTROL|LISTENER)[ \t]*$'
  $endRegex = '(?m)^\s*#\s*END\s+([A-Z][A-Z ]+?)\s+(CONTROL|LISTENER)[ \t]*$'
  $begins = [regex]::Matches($content, $beginRegex)
  $ends = [regex]::Matches($content, $endRegex)
  $consumedEnds = @{}
  foreach ($begin in $begins) {
    $family = ($begin.Groups[1].Value + " " + $begin.Groups[2].Value);
    $regionEnd = -1
    # 找 BEGIN 之后第一个同名 END（防交错错配）
    foreach ($end in $ends) {
      $endFamily = ($end.Groups[1].Value + " " + $end.Groups[2].Value)
      if ($end.Index -gt $begin.Index -and -not $consumedEnds.ContainsKey($end.Index) -and $endFamily -eq $family) {
        $regionEnd = $end.Index + $end.Length
        $consumedEnds[$end.Index] = $true
        break
      }
    }
    $regions += [pscustomobject]@{
      markerFamily = $family
      start = $begin.Index
      end = $regionEnd
      unclosed = ($regionEnd -lt 0)
    }
  }
  return $regions
}

function Find-AgentConflicts([string]$content) {
  $regions = Get-AgentMarkerRegions $content
  $conflicts = @()
  foreach ($region in $regions) {
    if ($region.unclosed) {
      $conflicts += [pscustomobject]@{ type = "unclosed"; markerFamily = $region.markerFamily; start = $region.start; end = $region.end; message = "SSH 配置中「$($region.markerFamily)」区块缺少结束标记（配置可能被破坏）" }
      continue
    }
    # 嵌套检测：本区间内部是否含另一家族的完整 BEGIN…END
    foreach ($other in $regions) {
      if ($other.markerFamily -eq $region.markerFamily) { continue }
      if ($other.start -gt $region.start -and $other.end -gt 0 -and $other.end -le $region.end) {
        $conflicts += [pscustomobject]@{ type = "nested"; markerFamily = $region.markerFamily; nestedFamily = $other.markerFamily; start = $region.start; end = $region.end; message = "SSH 配置中「$($other.markerFamily)」区块嵌进了「$($region.markerFamily)」区块内部（卸载任一方会连带删掉另一方，导致联动反复失效）" }
      }
    }
  }
  # 同名 marker 区间重复（重复写入）
  $families = $regions | Group-Object markerFamily
  foreach ($group in $families) {
    if ($group.Count -gt 1) {
      $conflicts += [pscustomobject]@{ type = "duplicate"; markerFamily = $group.Name; start = -1; end = -1; message = "SSH 配置中出现 $($group.Count) 处「$($group.Name)」区块（重复写入）" }
    }
  }
  return [pscustomobject]@{ regions = $regions; conflicts = $conflicts }
}

function Test-ClaudeNasControlInUse {
  # 另一套（Agent Orbit / Claude NAS 系）是否仍在被认领使用
  try {
    $legacyAgentRoot = Join-Path $env:ProgramData "ClaudeNasAgent"
    $legacyStatePath = Join-Path $legacyAgentRoot "install-state.json"
    if (-not (Test-Path $legacyStatePath)) { return $false }
    $legacyState = Get-Content -Raw -LiteralPath $legacyStatePath | ConvertFrom-Json
    return [bool]($legacyState -and $legacyState.installed)
  } catch { return $false }
}

function Test-LegacyOrphan {
  # Claude NAS 系资源在机上但无人认领（无 state 或 installed!=true）——可选清理的遗留
  try {
    $legacyAgentRoot = Join-Path $env:ProgramData "ClaudeNasAgent"
    if (-not (Test-Path $legacyAgentRoot)) { return $false }
    $legacyStatePath = Join-Path $legacyAgentRoot "install-state.json"
    if (-not (Test-Path $legacyStatePath)) { return $true }
    $legacyState = Get-Content -Raw -LiteralPath $legacyStatePath | ConvertFrom-Json
    return -not [bool]($legacyState -and $legacyState.installed)
  } catch { return $false }
}

# 把嵌进自家区间内的另一家族完整区块搬出到安全位置（平级化），幂等。
# 只挪异族完整区块文本，不改动任何区块内部内容；无嵌套时原样返回。
function Repair-NestedAgents([string]$content) {
  for ($pass = 0; $pass -lt 4; $pass++) {
    $report = Find-AgentConflicts $content
    $nested = $report.conflicts | Where-Object { $_.type -eq "nested" } | Select-Object -First 1
    if (-not $nested) { break }
    $content = Move-RegionToSafePosition $content $nested.nestedFamily
  }
  return $content
}

function Move-RegionToSafePosition([string]$content, [string]$nestedFamily) {
  $regions = Get-AgentMarkerRegions $content
  $target = $regions | Where-Object { $_.markerFamily -eq $nestedFamily -and -not $_.unclosed } | Select-Object -First 1
  if (-not $target) { return $content }
  $regionText = $content.Substring($target.start, $target.end - $target.start)
  $moved = $content.Remove($target.start, $target.end - $target.start).TrimEnd()
  # 在摊平后的内容中找第一个区间外的 Match 行，插到它之前；找不到则文件尾
  $insertAt = Find-SafeInsertOffset $moved
  $blockText = "`r`n" + $regionText.TrimEnd() + "`r`n`r`n"
  if ($insertAt -ge 0) { return $moved.Insert($insertAt, $blockText) }
  return $moved + "`r`n`r`n" + $blockText + "`r`n"
}

# 找「不属于任何 Agent marker 区间内部」的第一个 Match 行 offset；返回 -1 表示全部被区间包裹。
function Find-SafeInsertOffset([string]$content) {
  $regions = Get-AgentMarkerRegions $content
  foreach ($matchLine in [regex]::Matches($content, "(?im)^[ \t]*Match\s+")) {
    $pos = $matchLine.Index
    $inside = $false
    foreach ($region in $regions) {
      if ($region.end -ge 0) { if ($pos -gt $region.start -and $pos -lt $region.end) { $inside = $true } }
      else { if ($pos -gt $region.start) { $inside = $true } }  # 未闭合区间：其后全部视为危险
    }
    if (-not $inside) { return $pos }
  }
  return -1
}

function Show-ConflictWindow([object]$conflictReport, [string]$operation, [bool]$legacyOrphan) {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  $lines = @()
  foreach ($c in $conflictReport.conflicts) { $lines += ("• " + $c.message) }
  $claudeInUse = Test-ClaudeNasControlInUse
  foreach ($f in Get-CoexistingFamilies) {
    if ($f.id -eq "agent-chat-pro") { continue }
    if ($f.installed) { $lines += ("• 另一套联动控件在使用中：$($f.folder)（账号 $($f.account)）") }
  }
  if ($legacyOrphan) { $lines += "• 另发现旧版联动控件遗留（无人认领）" }
  $detailText = if ($lines.Count -gt 0) { ($lines -join "`n") } else { "本机存在多套 Agent 联动控件资源，未发现结构性错误。" }

  if ($operation -eq "Uninstall") {
    if ($claudeInUse) {
      $message = "检测到另一套 Agent 联动控件（Agent Orbit / Claude NAS 系）仍在使用中。`n`n$detailText`n`n本次卸载 Agent Chat Pro 联动控件时，另一套将原样保留（互不删改）。要继续卸载本应用的联动控件吗？"
      $choice = [System.Windows.Forms.MessageBox]::Show($message, "Agent 联动控件共存扫描", [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button1, [System.Windows.Forms.MessageBoxOptions]262144)
      if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) { return "keep-both-uninstall-self" }
      return "cancelled"
    }
    if ($legacyOrphan) {
      $message = "将卸载 Agent Chat Pro 联动控件。`n`n$detailText`n`n旧版遗留怎么处理？"
      $choice = [System.Windows.Forms.MessageBox]::Show($message, "Agent 联动控件共存扫描", [System.Windows.Forms.MessageBoxButtons]::YesNoCancel, [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button1, [System.Windows.Forms.MessageBoxOptions]262144)
      if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) { return "keep-both-uninstall-self" }
      if ($choice -eq [System.Windows.Forms.DialogResult]::No) { return "clean-legacy-orphan" }
      return "cancelled"
    }
  }

  # Install / 更新场景：结构修复 + 保留双方
  $message = "检测到本机可能并存另一套 Agent 联动控件（如 Agent Orbit / Claude NAS 系），双方将互相隔离、都保留。`n`n$detailText`n`n本次「$operation」如何处理？"
  $choice = [System.Windows.Forms.MessageBox]::Show($message, "Agent 联动控件共存扫描", [System.Windows.Forms.MessageBoxButtons]::YesNoCancel, [System.Windows.Forms.MessageBoxIcon]::Warning, [System.Windows.Forms.MessageBoxDefaultButton]::Button1, [System.Windows.Forms.MessageBoxOptions]262144)
  if ($choice -eq [System.Windows.Forms.DialogResult]::Yes) { return "repair-coexist" }
  if ($choice -eq [System.Windows.Forms.DialogResult]::No) { return "keep-structure" }
  return "cancelled"
}

function Get-CoexistingFamilies {
  $result = @()
  foreach ($key in $managedFamilies.Keys) {
    $family = $managedFamilies[$key]
    $familyFolder = Join-Path $env:ProgramData $family.folder
    $familyState = $null
    if (Test-Path (Join-Path $familyFolder "install-state.json")) {
      try { $familyState = Get-Content -Raw -LiteralPath (Join-Path $familyFolder "install-state.json") | ConvertFrom-Json } catch {}
    }
    $result += [pscustomobject]@{
      id = $key
      folderPresent = (Test-Path $familyFolder)
      installed = [bool]($familyState -and $familyState.installed)
      account = $family.account
      accountPresent = [bool](Get-LocalUser -Name $family.account -ErrorAction SilentlyContinue)
      firewallRulePresent = [bool](Get-NetFirewallRule -Name $family.firewallRule -ErrorAction SilentlyContinue)
    }
  }
  return $result
}

function Set-AgentBlock([string]$authorizedKeysFile, [switch]$KeepStructure) {
  $content = if (Test-Path $sshdConfig) { Get-Content -Raw -LiteralPath $sshdConfig } else { "" }
  $content = Remove-AgentBlock $content
  $keyPath = $authorizedKeysFile.Replace("\", "/")
  $block = @"
$markerStart
Match User agentchatprocontrol
    PasswordAuthentication no
    AuthorizedKeysFile $keyPath
$markerEnd

"@
  # v3.16.2 安全插入位：绝不插进任何 Agent marker 区间内部（v3.16.1 之前按「第一个 Match 行」
  # 插入，另一套控件先装机时会把本方区块嵌进对方区块内部——任一方卸载即连带删掉另一方）。
  if ($KeepStructure) {
    # 「保持现状」选择：按旧行为插入，不重排既有结构（用户在共存弹窗里明确选择时）
    $firstMatch = [regex]::Match($content, "(?im)^\s*Match\s+")
    if ($firstMatch.Success) {
      $content = $content.Insert($firstMatch.Index, $block)
    } else {
      $content = $content.TrimEnd() + "`r`n`r`n" + $block
    }
  } else {
    $safeOffset = Find-SafeInsertOffset $content
    if ($safeOffset -ge 0) {
      $content = $content.Insert($safeOffset, $block)
    } else {
      $content = $content.TrimEnd() + "`r`n`r`n" + $block + "`r`n"
    }
  }
  [IO.File]::WriteAllText($sshdConfig, $content, (New-Object Text.UTF8Encoding($false)))
}

function New-RandomSecurePassword {
  $bytes = New-Object byte[] 48
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  ConvertTo-SecureString ([Convert]::ToBase64String($bytes)) -AsPlainText -Force
}

function Test-PasswordlessLocalLogon([string]$userName) {
  $user = Get-LocalUser -Name $userName -ErrorAction SilentlyContinue
  if (-not $user -or -not $user.Enabled) { return $false }
  if (-not ("AgentChatProNativeLogon" -as [type])) {
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class AgentChatProNativeLogon {
  [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  public static extern bool LogonUser(string userName, string domain, string password, int logonType, int logonProvider, out IntPtr token);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
}
"@
  }
  $token = [IntPtr]::Zero
  try {
    return [AgentChatProNativeLogon]::LogonUser($userName, $env:COMPUTERNAME, "", 2, 0, [ref]$token)
  } finally {
    if ($token -ne [IntPtr]::Zero) { [AgentChatProNativeLogon]::CloseHandle($token) | Out-Null }
  }
}

function Preserve-PasswordlessAutoLogon {
  # Never read, store, or replace a user's password. This only repairs the legacy
  # single-user, blank-password auto-logon configuration after confirming it works.
  try {
    $winlogonPath = "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
    $winlogon = Get-ItemProperty -Path $winlogonPath
    $passwordValue = Get-ItemProperty -Path $winlogonPath -Name "DefaultPassword" -ErrorAction SilentlyContinue
    $hasDefaultPassword = $null -ne $passwordValue -and $null -ne $passwordValue.PSObject.Properties["DefaultPassword"]
    if ([string]$winlogon.AutoAdminLogon -ne "1" -or $hasDefaultPassword) {
      return [ordered]@{ preserved = $false; reason = "not-passwordless-autologon" }
    }

    $activeIdentity = [string](Get-CimInstance Win32_ComputerSystem).UserName
    $identityParts = $activeIdentity -split "\\", 2
    if ($identityParts.Count -ne 2 -or $identityParts[0] -ne $env:COMPUTERNAME -or -not $identityParts[1]) {
      return [ordered]@{ preserved = $false; reason = "active-user-is-not-local" }
    }
    $activeUser = $identityParts[1]
    $configuredUser = [string]$winlogon.DefaultUserName
    if ($configuredUser -and $configuredUser -ne $activeUser) {
      return [ordered]@{ preserved = $false; reason = "configured-user-differs" }
    }
    if (-not (Test-PasswordlessLocalLogon $activeUser)) {
      return [ordered]@{ preserved = $false; reason = "blank-password-not-confirmed" }
    }

    New-ItemProperty -Path $winlogonPath -Name "DefaultUserName" -PropertyType String -Value $activeUser -Force | Out-Null
    New-ItemProperty -Path $winlogonPath -Name "DefaultPassword" -PropertyType String -Value "" -Force | Out-Null
    return [ordered]@{ preserved = $true; account = $activeUser; reason = "blank-password-autologon-completed" }
  } catch {
    # Auto-logon is optional. A policy or an unavailable console session must not block pairing.
    return [ordered]@{ preserved = $false; reason = "autologon-check-unavailable" }
  }
}

function Set-AccountPermission([string]$mode) {
  $user = Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue
  $created = $false
  if (-not $user) {
    New-LocalUser -Name $accountName -Password (New-RandomSecurePassword) -AccountNeverExpires -PasswordNeverExpires -UserMayNotChangePassword -Description "Agent CLI Control; SSH key only" | Out-Null
    $created = $true
  } else {
    Enable-LocalUser -Name $accountName
    if ($user.Description -in @("Agent CLI Control; SSH key only", "Claude NAS Agent; SSH key only")) { $created = $true }
  }
  $administrators = Get-LocalGroup -SID "S-1-5-32-544"
  $isAdministrator = Get-LocalGroupMember -Group $administrators -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "\\$([regex]::Escape($accountName))$" }
  if ($mode -eq "administrator" -and -not $isAdministrator) {
    Add-LocalGroupMember -Group $administrators -Member $accountName
  } elseif ($mode -ne "administrator" -and $isAdministrator) {
    Remove-LocalGroupMember -Group $administrators -Member $accountName
  }
  return $created
}

function Install-Control($config) {
  $script:stage = "check-windows-version"
  $version = [Environment]::OSVersion.Version
  if ($version.Major -ne 10 -or $version.Build -lt 17763) {
    throw "Windows 10 1809 build 17763 or later, or Windows 11, is required."
  }
  if ($PSVersionTable.PSVersion -lt [Version]"5.1") {
    throw "PowerShell 5.1 or later is required."
  }
  if ($config.publicKey -notmatch "^(ssh-ed25519|ecdsa-sha2-nistp(256|384|521)|ssh-rsa) [A-Za-z0-9+/]+={0,3}( .*)?$") {
    throw "The management SSH public key is invalid."
  }

  # ── v3.16.2 共存扫描：安装/更新前必扫。结构冲突必弹窗（Windows 原生 MessageBox）让用户选择；
  # 干净共存首次弹一次告知（install-state 里 coexistenceAcked 记录后再弹会打扰），之后自动隔离共存。
  $script:stage = "scan-coexistence"
  $script:coexistenceChoice = "none"
  $script:coexistenceDetected = $false
  $configText = if (Test-Path $sshdConfig) { Get-Content -Raw -LiteralPath $sshdConfig } else { "" }
  $script:coexistenceReport = Find-AgentConflicts $configText
  $claudeInUse = Test-ClaudeNasControlInUse
  $legacyOrphan = Test-LegacyOrphan
  $otherFamilyPresent = $claudeInUse -or $legacyOrphan
  $hasStructuralConflicts = @($script:coexistenceReport.conflicts).Count -gt 0
  $ackedBefore = $false
  if (Test-Path $statePath) {
    try { $ackedBefore = [bool]((Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json).coexistenceAcked) } catch { $ackedBefore = $false }
  }
  $script:coexistenceDetected = ($otherFamilyPresent -or $hasStructuralConflicts)
  if ($claudeInUse) { $script:coexistenceDetected = $true }
  $shouldPrompt = $hasStructuralConflicts -or ($otherFamilyPresent -and -not $ackedBefore)
  if ($shouldPrompt) {
    $script:stage = "coexistence-prompt"
    $script:coexistenceChoice = Show-ConflictWindow $script:coexistenceReport "Install" $legacyOrphan
    if ($script:coexistenceChoice -eq "cancelled") {
      throw "User cancelled the device-control install after the coexistence scan. Nothing was changed."
    }
  }
  $repairStructure = ($script:coexistenceChoice -eq "repair-coexist") -or ($hasStructuralConflicts -and $script:coexistenceChoice -ne "keep-structure")
  if (-not $script:coexistenceDetected) { $script:coexistenceChoice = "clean" }

  $script:stage = "check-openssh-server"
  New-Item -ItemType Directory -Force -Path $agentRoot | Out-Null
  $capability = Get-OpenSshCapability
  $capabilityWasInstalled = $capability -and $capability.State -eq "Installed"
  $serviceBefore = Get-Service -Name sshd -ErrorAction SilentlyContinue
  $serverWasPresent = $capabilityWasInstalled -or ($serviceBefore -and (Get-OpenSshExecutable))
  $serviceWasRunning = $serviceBefore -and $serviceBefore.Status -eq "Running"
  $startupBefore = if ($serviceBefore) { (Get-CimInstance Win32_Service -Filter "Name='sshd'").StartMode } else { "Missing" }
  $defaultRule = Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
  $defaultRuleWasEnabled = $defaultRule -and $defaultRule.Enabled -eq "True"

  if (-not $serverWasPresent) {
    if (-not $capability) { throw "OpenSSH Server is not available as a Windows capability." }
    $script:stage = "install-openssh-server"
    $capabilityResult = Add-WindowsCapability -Online -Name $capability.Name
    if ($capabilityResult.RestartNeeded) { throw "OpenSSH Server was installed, but Windows requires a restart before it can be configured. Restart Windows, then click install again." }
  }
  $script:stage = "check-openssh-runtime"
  Assert-OpenSshRuntime
  if (-not (Test-Path $sshdConfig)) {
    Start-Service sshd
    Stop-Service sshd
  }
  $currentConfig = Get-Content -Raw -LiteralPath $sshdConfig
  if ($repairStructure) { $currentConfig = Repair-NestedAgents $currentConfig }
  $originalConfig = Remove-AgentBlock $currentConfig
  $accountCreated = $false
  $autoLogonProtection = [ordered]@{ preserved = $false; reason = "not-run" }
  try {
    if ($currentConfig -ne $originalConfig) {
      [IO.File]::WriteAllText($sshdConfig, $originalConfig, (New-Object Text.UTF8Encoding($false)))
    }
    $script:stage = "preserve-passwordless-autologon"
    $autoLogonProtection = Preserve-PasswordlessAutoLogon
    $script:stage = "create-control-account"
    $accountCreated = Set-AccountPermission ([string]$config.permissionMode)
    $script:stage = "write-control-key"
    $authorizedKeys = Join-Path $agentRoot "authorized_keys"
    [IO.File]::WriteAllText($authorizedKeys, ([string]$config.publicKey).Trim() + "`n", (New-Object Text.UTF8Encoding($false)))
    & icacls.exe $agentRoot /inheritance:r /grant "*S-1-5-18:(OI)(CI)F" /grant "*S-1-5-32-544:(OI)(CI)F" /grant "*S-1-5-32-545:(OI)(CI)RX" /grant "$accountName`:(OI)(CI)R" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "Failed to set permissions on the device-control key directory." }

    $script:stage = "validate-sshd-config"
    if ($script:coexistenceChoice -eq "keep-structure") { Set-AgentBlock $authorizedKeys -KeepStructure } else { Set-AgentBlock $authorizedKeys }
    Assert-SshdConfig $authorizedKeys
    $script:stage = "configure-firewall"
    Remove-NetFirewallRule -Name $firewallRule -ErrorAction SilentlyContinue
    New-NetFirewallRule -Name $firewallRule -DisplayName "Agent CLI Control (management source only)" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 22 -RemoteAddress ([string]$config.sourceAddress) -Profile Private,Domain | Out-Null
    if (-not $serverWasPresent -and (Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) {
      Disable-NetFirewallRule -Name "OpenSSH-Server-In-TCP"
    }
    $script:stage = "start-sshd-service"
    Set-Service sshd -StartupType Automatic
    if ((Get-Service sshd).Status -eq "Running") { Restart-Service sshd -Force }
    else { Start-Service sshd }
    (Get-Service sshd).WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(15))
  } catch {
    [IO.File]::WriteAllText($sshdConfig, $originalConfig, (New-Object Text.UTF8Encoding($false)))
    Remove-NetFirewallRule -Name $firewallRule -ErrorAction SilentlyContinue
    if ($accountCreated -and (Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue)) { Remove-LocalUser -Name $accountName }
    try {
      if ((Get-Service sshd).Status -eq "Running") { Restart-Service sshd -Force }
      elseif ($serviceWasRunning) { Start-Service sshd }
    } catch {}
    throw
  }

  $state = [ordered]@{
    installed = $true
    installedAt = [DateTime]::UtcNow.ToString("o")
    account = $accountName
    accountCreated = $accountCreated
    permissionMode = [string]$config.permissionMode
    sourceAddress = [string]$config.sourceAddress
    targetAddress = [string]$config.targetAddress
    targetPort = [int]$config.targetPort
    deviceId = [string]$config.deviceId
    managementKeyPath = [string]$config.managementKeyPath
    capabilityWasInstalled = $capabilityWasInstalled
    serverWasPresent = $serverWasPresent
    serviceWasRunning = $serviceWasRunning
    serviceStartupBefore = $startupBefore
    defaultFirewallWasEnabled = $defaultRuleWasEnabled
    existingBroadFirewallWarning = $capabilityWasInstalled -and $defaultRuleWasEnabled
    autoLogonProtection = $autoLogonProtection
    coexistenceAcked = $true
    coexistenceChoice = $script:coexistenceChoice
    coexistenceDetected = $script:coexistenceDetected
  }
  $script:stage = "save-install-state"
  [IO.File]::WriteAllText($statePath, ($state | ConvertTo-Json -Depth 4), (New-Object Text.UTF8Encoding($false)))
}

function Uninstall-Control {
  $state = if (Test-Path $statePath) { Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json } else { $null }
  # Legacy compatibility: also remove old-named firewall rule and Match block from prior versions
  $legacyMarkerStart = "# BEGIN CLAUDE NAS AGENT CONTROL"
  $legacyMarkerEnd = "# END CLAUDE NAS AGENT CONTROL"
  $legacyFirewallRule = "ClaudeNAS-Agent-Control"
  $legacyAccountName = "ClaudeAgentControl"
  $legacyAgentRoot = Join-Path $env:ProgramData "ClaudeNasAgent"
  $legacyStatePath = Join-Path $legacyAgentRoot "install-state.json"
  # ── v3.16.2 共存扫描：卸载前必扫。另一套（Agent Orbit / Claude NAS 系）在用 = 一个字节都不碰；
  # 无人认领的遗留 = Windows 弹窗让用户选「保留 / 连带清理 / 取消」。
  $script:stage = "scan-coexistence"
  $script:coexistenceChoice = "none"
  $script:coexistenceDetected = $false
  $claudeInUse = Test-ClaudeNasControlInUse
  $legacyOrphan = Test-LegacyOrphan
  $configText = if (Test-Path $sshdConfig) { Get-Content -Raw -LiteralPath $sshdConfig } else { "" }
  $script:coexistenceReport = Find-AgentConflicts $configText
  $hasStructuralConflicts = @($script:coexistenceReport.conflicts).Count -gt 0
  $script:coexistenceDetected = ($claudeInUse -or $legacyOrphan -or $hasStructuralConflicts)
  $cleanLegacy = $false
  if ($claudeInUse -or $legacyOrphan) {
    $script:stage = "coexistence-prompt"
    $script:coexistenceChoice = Show-ConflictWindow $script:coexistenceReport "Uninstall" $legacyOrphan
    if ($script:coexistenceChoice -eq "cancelled") {
      throw "User cancelled the device-control uninstall after the coexistence scan. Nothing was changed."
    }
    $cleanLegacy = ($script:coexistenceChoice -eq "clean-legacy-orphan")
  }
  if (Test-Path $sshdConfig) {
    # 先摊平嵌套（AO 区间若嵌在本方区间内，卸载本方时先把对方完整搬出，内容不变），再删本方区间
    $content = Repair-NestedAgents (Get-Content -Raw -LiteralPath $sshdConfig)
    $content = Remove-AgentBlock $content
    if ($cleanLegacy) {
      # Only when the user explicitly chose to clean the unclaimed legacy is the old marker block touched
      $legacyPattern = "(?ms)^" + [regex]::Escape($legacyMarkerStart) + ".*?^" + [regex]::Escape($legacyMarkerEnd) + "\s*"
      $content = [regex]::Replace($content, $legacyPattern, "")
    }
    [IO.File]::WriteAllText($sshdConfig, $content, (New-Object Text.UTF8Encoding($false)))
  }
  Remove-NetFirewallRule -Name $firewallRule -ErrorAction SilentlyContinue
  if ($cleanLegacy) { Remove-NetFirewallRule -Name $legacyFirewallRule -ErrorAction SilentlyContinue }
  $managedUser = Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue
  if ($managedUser -and (($state -and $state.accountCreated) -or $managedUser.Description -in @("Agent CLI Control; SSH key only", "Claude NAS Agent; SSH key only"))) {
    Remove-LocalUser -Name $accountName
  } else {
    Disable-LocalUser -Name $accountName -ErrorAction SilentlyContinue
  }
  # Legacy account cleanup only when the user chose to clean the unclaimed legacy orphan
  if ($cleanLegacy) {
    $legacyUser = Get-LocalUser -Name $legacyAccountName -ErrorAction SilentlyContinue
    if ($legacyUser -and $legacyUser.Description -in @("Agent CLI Control; SSH key only", "Claude NAS Agent; SSH key only")) {
      Remove-LocalUser -Name $legacyAccountName -ErrorAction SilentlyContinue
    }
  }
  if (Get-Service -Name sshd -ErrorAction SilentlyContinue) {
    if ($state -and -not $state.serviceWasRunning) { Stop-Service sshd -Force -ErrorAction SilentlyContinue }
    else { Restart-Service sshd -Force }
    if ($state) {
      if ($state.serviceStartupBefore -eq "Disabled") { Set-Service sshd -StartupType Disabled }
      elseif ($state.serviceStartupBefore -eq "Manual") { Set-Service sshd -StartupType Manual }
      elseif ($state.serviceStartupBefore -eq "Auto") { Set-Service sshd -StartupType Automatic }
    }
  }
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath (Join-Path $agentRoot "authorized_keys") -Force -ErrorAction SilentlyContinue
  # Legacy directory cleanup only when the user chose to clean the unclaimed legacy orphan
  if ($cleanLegacy -and (Test-Path $legacyAgentRoot)) { Remove-Item -LiteralPath $legacyAgentRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

$config = $null
$stage = "read-installer-config"
try {
  $config = Get-Content -Raw -LiteralPath $ConfigPath | ConvertFrom-Json
  $stage = "check-administrator"
  Assert-Administrator
  if ($config.action -eq "Install") { Install-Control $config }
  elseif ($config.action -eq "Uninstall") { Uninstall-Control }
  else { throw "Unknown device-control action." }
  # Success path: report the coexistence scan outcome back to the client as JSON.
  # (Error path keeps the legacy plain-text "[stage] message" format for localizedInstallerError.)
  $conflictTypes = @()
  if ($script:coexistenceReport) { $conflictTypes = @($script:coexistenceReport.conflicts | ForEach-Object { $_.type }) }
  $resultPayload = [ordered]@{
    ok = $true
    action = $config.action
    completedAt = [DateTime]::UtcNow.ToString("o")
    coexistence = [ordered]@{
      detected = [bool]$script:coexistenceDetected
      choice = $script:coexistenceChoice
      conflicts = $conflictTypes
      families = @(Get-CoexistingFamilies)
    }
  }
  [IO.File]::WriteAllText($ResultPath, ($resultPayload | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
} catch {
  $message = "[$stage] " + $_.Exception.Message
  [IO.File]::WriteAllText($ResultPath, $message, (New-Object Text.UTF8Encoding($false)))
  Write-Error $message
  exit 1
}
exit 0
