# Runs as a new standard user, not the privileged GitHub runner account.
$ErrorActionPreference = 'Stop'
$out = $PSScriptRoot
$result = @{success=$false; isAdministrator=$null; error=$null}
Start-Transcript (Join-Path $out 'user-transcript.txt')
try {
    $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = [System.Security.Principal.WindowsPrincipal]::new($identity)
    $result.isAdministrator = $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    $result.identity = $identity.Name
    # Do not let inherited runner environment variables point into its admin profile.
    $profileKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\' + $identity.User.Value
    $env:USERPROFILE = [Environment]::ExpandEnvironmentVariables((Get-ItemProperty $profileKey).ProfileImagePath)
    $env:LOCALAPPDATA = Join-Path $env:USERPROFILE 'AppData\Local'
    $env:APPDATA = Join-Path $env:USERPROFILE 'AppData\Roaming'
    $result.profile = $env:USERPROFILE
    whoami /all | Out-File (Join-Path $out 'user-token.txt')
    if ($result.isAdministrator) { throw 'Refusing to claim standard-user coverage with an elevated token' }
    foreach ($location in Get-Content (Join-Path $out 'frameworks.txt')) {
        Add-AppxPackage -Register (Join-Path $location 'AppxManifest.xml') -DisableDevelopmentMode
    }
    $app = Get-Content (Join-Path $out 'winget-location.txt')
    Add-AppxPackage -Register (Join-Path $app 'AppxManifest.xml') -DisableDevelopmentMode
    $winget = Join-Path $app 'winget.exe'
    & $winget --info
    if ($LASTEXITCODE -ne 0) { throw "User WinGet bootstrap failed: $LASTEXITCODE" }
    $installArgs = @('install', '--manifest', (Join-Path $out 'manifest'), '--accept-package-agreements',
        '--accept-source-agreements', '--disable-interactivity', '--verbose-logs')
    & $winget @installArgs
    if ($LASTEXITCODE -ne 0) { throw "Standard-user installation failed: $LASTEXITCODE" }
    $env:PATH = "$env:LOCALAPPDATA\Microsoft\WinGet\Links;$env:PATH"
    foreach ($command in @('considered', 'considered-scc')) {
        $source = (Get-Command $command).Source
        if (-not $source.StartsWith("$env:LOCALAPPDATA\Microsoft\WinGet\Links\")) {
            throw "Alias resolved outside the standard user installation: $source"
        }
    }
    & considered --version
    if ($LASTEXITCODE -ne 0) { throw "Installed considered failed: $LASTEXITCODE" }
    $fixture = Join-Path $out 'fixture'
    New-Item -ItemType Directory $fixture | Out-Null
    'package example' | Set-Content (Join-Path $fixture 'example.go')
    & considered-scc --json --root $fixture
    if ($LASTEXITCODE -ne 0) { throw "Installed provider failed: $LASTEXITCODE" }
    $result.success = $true
} catch {
    $result.error = $_.ToString()
    $_ | Format-List * -Force | Out-String | Write-Host
} finally {
    foreach ($path in @(
        "$env:LOCALAPPDATA\Packages\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\LocalState\DiagOutputDir",
        "$env:LOCALAPPDATA\Microsoft\WinGet\DiagOutputDir"
    )) {
        if (Test-Path $path) { Copy-Item $path (Join-Path $out ([guid]::NewGuid().ToString())) -Recurse }
    }
    $result | ConvertTo-Json | Set-Content (Join-Path $out 'result.json')
    Stop-Transcript
}
if (-not $result.success) { exit 1 }
