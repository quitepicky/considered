param(
    [Parameter(Mandatory)][string]$CandidateDirectory,
    [Parameter(Mandatory)][string]$EvidenceDirectory,
    [Parameter(Mandatory)][ValidateSet('amd64', 'arm64')][string]$Architecture
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
New-Item -ItemType Directory -Force $EvidenceDirectory | Out-Null
Start-Transcript -Path (Join-Path $EvidenceDirectory 'transcript.txt')
$server = $null
$installed = $false
$productCode = 'QuitePicky.Considered__DefaultSource'
$registrationPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$productCode"

function Invoke-WinGetChecked {
    param([string[]]$Arguments, [switch]$Validation)
    & winget @Arguments
    $code = $LASTEXITCODE
    # WinGet 1.11 reports schema-header warnings with this success-with-warning code.
    if ($Validation -and $code -eq -1978335192) {
        Write-Warning 'Manifest validation succeeded with warnings; inspect transcript.'
    } elseif ($code -ne 0) {
        throw "winget $($Arguments -join ' ') failed: $code"
    }
}

try {
    $native = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    $expected = if ($Architecture -eq 'amd64') { 'X64' } else { 'Arm64' }
    if ($native -ne $expected) { throw "Expected native $expected runner; found $native" }
    $candidate = Get-Content (Join-Path $CandidateDirectory 'candidate.json') -Raw | ConvertFrom-Json
    $version = $candidate.tag.Substring(1)
    Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture | Format-List
    foreach ($archive in $candidate.archives) {
        $hash = (Get-FileHash (Join-Path $CandidateDirectory $archive.name) -Algorithm SHA256).Hash
        if ($hash -ne $archive.sha256) { throw "Candidate archive hash mismatch: $($archive.name)" }
    }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Install-Module Microsoft.WinGet.Client -RequiredVersion 1.29.280 -Force -Repository PSGallery -Scope CurrentUser
        Import-Module Microsoft.WinGet.Client
        Repair-WinGetPackageManager -AllUsers -Version v1.29.290 -Verbose
        $env:PATH += ";$env:LOCALAPPDATA\Microsoft\WindowsApps"
    }
    Invoke-WinGetChecked -Arguments @('--info')
    Invoke-WinGetChecked -Arguments @('settings', '--enable', 'LocalManifestFiles')
    $original = Join-Path $CandidateDirectory 'manifest'
    Invoke-WinGetChecked -Arguments @('validate', '--manifest', $original) -Validation

    $ready = Join-Path $EvidenceDirectory 'server-url.txt'
    $node = (Get-Command node).Source
    $serverScript = Join-Path $PSScriptRoot 'serve-windows-candidate.mjs'
    $server = Start-Process -FilePath $node -PassThru -WindowStyle Hidden -ArgumentList @(
        "`"$serverScript`"", "`"$CandidateDirectory`"", "`"$ready`""
    ) -RedirectStandardOutput (Join-Path $EvidenceDirectory 'server.stdout.txt') `
      -RedirectStandardError (Join-Path $EvidenceDirectory 'server.stderr.txt')
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path $ready)) {
        if ($server.HasExited -or (Get-Date) -gt $deadline) { throw 'Candidate server did not start' }
        Start-Sleep -Milliseconds 200
    }
    $base = (Get-Content $ready -Raw).Trim()
    if ($base -notmatch '^http://127\.0\.0\.1:\d+$') { throw 'Expected loopback-only server' }
    $localManifest = Join-Path $EvidenceDirectory 'install-manifest'
    Copy-Item $original $localManifest -Recurse
    $installerFile = Join-Path $localManifest 'QuitePicky.Considered.installer.yaml'
    $installer = Get-Content $installerFile -Raw
    foreach ($archive in $candidate.archives) {
        if (-not $installer.Contains($archive.url)) { throw 'Expected original installer URL' }
        $installer = $installer.Replace($archive.url, "$base/$($archive.name)")
    }
    # Only the URL is substituted. The tested package hash and nested paths are unchanged.
    [System.IO.File]::WriteAllText($installerFile, $installer)
    Invoke-WinGetChecked -Arguments @('validate', '--manifest', $localManifest) -Validation
    Invoke-WinGetChecked -Arguments @('install', '--manifest', $localManifest, '--accept-package-agreements',
        '--accept-source-agreements', '--disable-interactivity', '--verbose-logs')
    $installed = $true
    $registration = Get-ItemProperty $registrationPath
    if ($registration.WinGetPackageIdentifier -ne 'QuitePicky.Considered' -or
        $registration.DisplayVersion -ne $version -or $registration.DisplayName -ne 'Considered') {
        throw 'Installed package registration does not match candidate identity/version'
    }
    $registration | Select-Object WinGetPackageIdentifier, DisplayName, DisplayVersion, UninstallString |
        ConvertTo-Json | Set-Content (Join-Path $EvidenceDirectory 'registration.json')
    $links = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
    $env:PATH = "$links;$env:PATH"
    foreach ($command in @('considered', 'considered-scc')) {
        $alias = Join-Path $links "$command.exe"
        if (-not (Test-Path $alias)) { throw "Missing installed alias: $command" }
        if ((Get-Command $command).Source -ne $alias) { throw "Wrong command resolved for $command" }
    }
    $actualVersion = & considered --version
    if ($LASTEXITCODE -ne 0 -or $actualVersion.Trim() -ne $candidate.tag) { throw 'Installed version mismatch' }
    Write-Output "Installed considered version: $actualVersion"
    $fixture = Join-Path $EvidenceDirectory 'fixture'
    New-Item -ItemType Directory -Force $fixture | Out-Null
    'package example' | Set-Content (Join-Path $fixture 'example.go')
    $metrics = & considered-scc --json --root $fixture
    if ($LASTEXITCODE -ne 0) { throw "Installed provider failed: $LASTEXITCODE" }
    $metrics | ConvertFrom-Json | Out-Null
    $metrics | Set-Content (Join-Path $EvidenceDirectory 'provider.json')
    # Local portable installs have an ARP ID until the package is in a catalog.
    # Verify exact identity/version in its registration above, list by exact name,
    # and uninstall by the product code recorded by WinGet (not a catalog ID).
    Invoke-WinGetChecked -Arguments @('source', 'update', '--name', 'winget', '--disable-interactivity')
    Invoke-WinGetChecked -Arguments @('list', '--name', 'Considered', '--exact',
        '--accept-source-agreements', '--disable-interactivity')
    Invoke-WinGetChecked -Arguments @('uninstall', '--product-code', $productCode,
        '--accept-source-agreements', '--disable-interactivity')
    $installed = $false
    if (Test-Path $registrationPath) { throw 'Uninstall left the package registration' }
    foreach ($command in @('considered', 'considered-scc')) {
        if (Test-Path (Join-Path $links "$command.exe")) { throw "Uninstall left alias: $command" }
    }
    [ordered]@{ tag = $candidate.tag; architecture = $Architecture; result = 'passed';
        originalManifestValidated = $true; installationTransport = 'loopback';
        archives = $candidate.archives } | ConvertTo-Json -Depth 6 |
        Set-Content (Join-Path $EvidenceDirectory 'result.json')
} finally {
    if ($installed) {
        & winget uninstall --product-code $productCode --accept-source-agreements --disable-interactivity
    }
    if ($null -ne $server -and -not $server.HasExited) { Stop-Process -Id $server.Id -ErrorAction Continue }
    $logDirectory = Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\LocalState\DiagOutputDir'
    if (Test-Path $logDirectory) {
        Copy-Item $logDirectory (Join-Path $EvidenceDirectory 'winget-logs') -Recurse -ErrorAction Continue
    }
    Stop-Transcript
}
