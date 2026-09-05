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

function Set-AgentBlock([string]$authorizedKeysFile) {
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
  $firstMatch = [regex]::Match($content, "(?im)^\s*Match\s+")
  if ($firstMatch.Success) {
    $content = $content.Insert($firstMatch.Index, $block)
  } else {
    $content = $content.TrimEnd() + "`r`n`r`n" + $block
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
    Set-AgentBlock $authorizedKeys
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
  $legacyState = if (Test-Path $legacyStatePath) { Get-Content -Raw -LiteralPath $legacyStatePath | ConvertFrom-Json } else { $null }
  if (Test-Path $sshdConfig) {
    $content = Remove-AgentBlock (Get-Content -Raw -LiteralPath $sshdConfig)
    # Also remove legacy marker block if present
    $legacyPattern = "(?ms)^" + [regex]::Escape($legacyMarkerStart) + ".*?^" + [regex]::Escape($legacyMarkerEnd) + "\s*"
    $content = [regex]::Replace($content, $legacyPattern, "")
    [IO.File]::WriteAllText($sshdConfig, $content, (New-Object Text.UTF8Encoding($false)))
  }
  Remove-NetFirewallRule -Name $firewallRule -ErrorAction SilentlyContinue
  Remove-NetFirewallRule -Name $legacyFirewallRule -ErrorAction SilentlyContinue
  $managedUser = Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue
  $legacyUser = Get-LocalUser -Name $legacyAccountName -ErrorAction SilentlyContinue
  if ($managedUser -and (($state -and $state.accountCreated) -or $managedUser.Description -in @("Agent CLI Control; SSH key only", "Claude NAS Agent; SSH key only"))) {
    Remove-LocalUser -Name $accountName
  } else {
    Disable-LocalUser -Name $accountName -ErrorAction SilentlyContinue
  }
  # Clean up legacy account if it exists from prior version
  if ($legacyUser -and $legacyUser.Description -in @("Agent CLI Control; SSH key only", "Claude NAS Agent; SSH key only")) {
    Remove-LocalUser -Name $legacyAccountName -ErrorAction SilentlyContinue
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
  # Clean up legacy state directory if it exists from prior version
  if (Test-Path $legacyAgentRoot) { Remove-Item -LiteralPath $legacyAgentRoot -Recurse -Force -ErrorAction SilentlyContinue }
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
} catch {
  $message = "[$stage] " + $_.Exception.Message
  [IO.File]::WriteAllText($ResultPath, $message, (New-Object Text.UTF8Encoding($false)))
  Write-Error $message
  exit 1
}
exit 0
