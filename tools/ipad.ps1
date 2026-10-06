# Helpers for talking to the jailbroken iPad over SSH as root with the key ~/.ssh/ipad_ios6 (dot-source this file).
#   . .\tools\ipad.ps1
#   Invoke-IPad 'uname -a'
#   Install-IPadPackage -IpaPath .\packages\run-<id>\Kodium-0.1.0.ipa -DebPath .\packages\run-<id>\Kodium-0.1.0.deb
#   Get-IPadCrashLogs; Get-KodiumLog
# The address is "ipad" in tools/local.json.

$script:IPadKey = Join-Path $env:USERPROFILE '.ssh\ipad_ios6'
$script:IPadDefaultHost = '192.168.1.165'
$script:IPadLocalCfg = Join-Path $PSScriptRoot 'local.json'
if (Test-Path $script:IPadLocalCfg) {
    try {
        $c = Get-Content $script:IPadLocalCfg -Raw | ConvertFrom-Json
        if ($c.ipad) { $script:IPadDefaultHost = $c.ipad }
    } catch {}
}

function Get-IPadSshArgs {
    # (keepalives end a session whose Wi-Fi link died instead of waiting for ever)
    @('-i', $script:IPadKey, '-oHostKeyAlgorithms=+ssh-rsa', '-oStrictHostKeyChecking=accept-new', '-oConnectTimeout=10', '-oBatchMode=yes', '-oLogLevel=ERROR',
      '-oServerAliveInterval=5', '-oServerAliveCountMax=4')
}

# Runs a command on the iPad and returns stdout+stderr as plain strings (never throws on stderr output).
function Invoke-IPad {
    param([Parameter(Mandatory = $true)][string]$Command, [string]$IPadHost = $script:IPadDefaultHost)
    $ErrorActionPreference = 'Continue'   # function-local: native stderr must not become a terminating error
    $sshArgs = Get-IPadSshArgs
    & ssh.exe @sshArgs "root@$IPadHost" $Command 2>&1 |
        ForEach-Object { if ($_ -is [Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_ } }
}

function Copy-ToIPad {
    param([Parameter(Mandatory = $true)][string]$LocalPath, [Parameter(Mandatory = $true)][string]$RemotePath, [string]$IPadHost = $script:IPadDefaultHost)
    $ErrorActionPreference = 'Continue'
    $sshArgs = Get-IPadSshArgs
    & scp.exe -O @sshArgs $LocalPath "root@${IPadHost}:$RemotePath" 2>&1 |
        ForEach-Object { if ($_ -is [Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_ } }
    if ($LASTEXITCODE -ne 0) { throw "scp failed for $LocalPath" }
}

function Copy-FromIPad {
    param([Parameter(Mandatory = $true)][string]$RemotePath, [Parameter(Mandatory = $true)][string]$LocalPath, [string]$IPadHost = $script:IPadDefaultHost)
    $ErrorActionPreference = 'Continue'
    $sshArgs = Get-IPadSshArgs
    & scp.exe -O @sshArgs -r "root@${IPadHost}:$RemotePath" $LocalPath 2>&1 |
        ForEach-Object { if ($_ -is [Management.Automation.ErrorRecord]) { $_.Exception.Message } else { $_ } }
    if ($LASTEXITCODE -ne 0) { throw "scp failed for $RemotePath" }
}

# The IPA through ipainstaller (or appinst); the .deb only when that fails. Kodium is ended first.
function Install-IPadPackage {
    param([string]$IpaPath, [string]$DebPath, [string]$IPadHost = $script:IPadDefaultHost)
    $installed = $false
    Invoke-IPad -IPadHost $IPadHost -Command 'killall Kodium 2>/dev/null; echo stopped' | Out-Null
    if ($IpaPath -and (Test-Path $IpaPath)) {
        Write-Host "Installing IPA $IpaPath ..."
        Copy-ToIPad -LocalPath $IpaPath -RemotePath '/tmp/Kodium.ipa' -IPadHost $IPadHost
        $out = Invoke-IPad -IPadHost $IPadHost -Command 'if command -v ipainstaller >/dev/null 2>&1; then ipainstaller -f /tmp/Kodium.ipa; echo "IPA_EXIT=$?"; elif command -v appinst >/dev/null 2>&1; then appinst /tmp/Kodium.ipa; echo "IPA_EXIT=$?"; else echo NO_INSTALLER; fi; rm -f /tmp/Kodium.ipa' | Out-String
        Write-Host $out
        # (ipainstaller's exit code is not reliable: its own success message counts as well)
        if ($out -match 'IPA_EXIT=0' -or $out -match '(?i)installed .* successfully') { $installed = $true }
    }
    if (-not $installed -and $DebPath -and (Test-Path $DebPath)) {
        Write-Host "Installing DEB $DebPath ..."
        Copy-ToIPad -LocalPath $DebPath -RemotePath '/tmp/Kodium.deb' -IPadHost $IPadHost
        $out = Invoke-IPad -IPadHost $IPadHost -Command 'dpkg -i /tmp/Kodium.deb 2>&1 && { uicache 2>/dev/null; echo DEB_OK; }; rm -f /tmp/Kodium.deb' | Out-String
        Write-Host $out
        if ($out -match 'DEB_OK') { $installed = $true }
    }
    if (-not $installed) { throw "Nothing installed" }
    Write-Host "Done. Tap the Kodium icon on the iPad."
}

function Get-IPadCrashLogs {
    param([string]$IPadHost = $script:IPadDefaultHost, [string]$OutDir = '')
    if (-not $OutDir) { $OutDir = Join-Path (Split-Path -Parent $PSScriptRoot) 'packages\crashlogs' }
    New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
    # (the iPad has no head/tail/wc/awk; sed does their work)
    $list = Invoke-IPad -IPadHost $IPadHost -Command "ls -t /var/mobile/Library/Logs/CrashReporter/ 2>/dev/null | grep -i -e Kodium -e LowMemory | sed -n '1,5p'"
    foreach ($f in (@($list) -join "`n" -split "`n" | Where-Object { $_.Trim() })) {
        $name = $f.Trim()
        Copy-FromIPad -IPadHost $IPadHost -RemotePath "/var/mobile/Library/Logs/CrashReporter/$name" -LocalPath (Join-Path $OutDir $name)
        Write-Host "Fetched $name"
    }
}

# The engine's log lines (prefix [Surfari]: the engine's own; the app logs only on a developer's device, see BRCommon)
function Get-KodiumLog {
    param([int]$Lines = 60, [string]$IPadHost = $script:IPadDefaultHost)
    Invoke-IPad -IPadHost $IPadHost -Command "grep -e Kodium -e '\[Surfari\]' /var/log/syslog | sed -e :a -e '`$q;N;$($Lines + 1),`$D;ba'"
}

# The app's sandbox folder on the iPad (it changes with a reinstall)
function Get-IPadAppContainer {
    param([string]$IPadHost = $script:IPadDefaultHost)
    $out = (Invoke-IPad -IPadHost $IPadHost -Command "ls -d /var/mobile/Applications/*/Kodium.app 2>/dev/null | sed -n '1p'" | Out-String).Trim()
    if (-not $out) { throw 'Kodium is not installed on the iPad' }
    $out -replace '/Kodium\.app$', ''
}
