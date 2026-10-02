# Diagnostic only: no release writes, credentials, AV exclusions, or disabled protection.
# The upstream manifest commit and archive hashes are intentionally immutable.
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $false
$out = Join-Path $env:RUNNER_TEMP 'considered-diagnostics'
New-Item -ItemType Directory -Force $out | Out-Null
$started = Get-Date
Start-Transcript -Path (Join-Path $out 'transcript.txt')
$failures = [System.Collections.Generic.List[string]]::new()

function Record-Step([string]$Name, [scriptblock]$Action) {
    Write-Host "=== $Name ==="
    try { & $Action } catch {
        $failures.Add("${Name}: $_")
        Write-Warning "${Name}: $_"
        $_ | Format-List * -Force | Out-String | Write-Host
    }
}

try {
    Record-Step 'Defender health and signatures' {
        # The ARM runner's Defender WMI provider can still be starting up.
        Start-Service WinDefend
        for ($attempt = 0; $attempt -lt 3; $attempt++) {
            try { $status = Get-MpComputerStatus; break } catch {
                if ($attempt -eq 2) { throw }
                Start-Sleep -Seconds 5
            }
        }
        $status | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $out 'defender-before.json')
        & "$PSScriptRoot/windows-defender-setup.ps1" -Evidence $out
        if (-not $status.RealTimeProtectionEnabled) {
            # Hosted runners may start with real-time monitoring disabled.
            # Strengthen protection in this disposable runner; never add exclusions.
            Set-MpPreference -DisableRealtimeMonitoring $false
            for ($attempt = 0; $attempt -lt 10; $attempt++) {
                $status = Get-MpComputerStatus
                if ($status.RealTimeProtectionEnabled) { break }
                Start-Sleep -Seconds 2
            }
        }
        if (-not $status.AntivirusEnabled -or -not $status.RealTimeProtectionEnabled) {
            throw 'Defender is not active on this runner; this cannot establish a clean result.'
        }
        # A platform update may restart Defender and interrupt the first RPC.
        # Retry the update, then require fresh signatures; never ignore scan errors.
        for ($attempt = 0; $attempt -lt 3; $attempt++) {
            try { Update-MpSignature; break } catch {
                if ($attempt -eq 2) { throw }
                Write-Warning "Signature update interrupted; retrying: $_"
                Start-Sleep -Seconds 10
            }
        }
        $status = Get-MpComputerStatus
        if (-not $status.RealTimeProtectionEnabled -or $status.AntivirusSignatureAge -gt 2 -or
            -not $status.BehaviorMonitorEnabled -or -not $status.IoavProtectionEnabled) {
            throw 'Defender must be active with signatures no older than two days.'
        }
    }
    $arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64') { 'arm64' } else { 'amd64' }
    $expected = @{
        amd64 = 'af5e6e4f53c7a7ad4db7ddcc5224dc55f46db541e6d5ed5b6a9f5cbf16574130'
        arm64 = 'f30f9216b3c6f14fc7fbe7c40c2e15b33aa71414c20d37076e6bafb38e966d9a'
    }
    $archive = Join-Path $env:RUNNER_TEMP "considered_v0.1.11_windows_${arch}.zip"
    $expanded = Join-Path $env:RUNNER_TEMP 'considered-published-binaries'
    Record-Step 'Verify and scan published archive' {
        $releaseBase = 'https://github.com/quitepicky/considered/releases/download/v0.1.11'
        Invoke-WebRequest "$releaseBase/considered_v0.1.11_windows_${arch}.zip" -OutFile $archive
        $hash = (Get-FileHash $archive -Algorithm SHA256).Hash
        if ($hash -ne $expected[$arch]) { throw "Archive hash mismatch: $hash" }
        Start-MpScan -ScanType CustomScan -ScanPath $archive
        Expand-Archive $archive $expanded
        Get-ChildItem $expanded -Recurse -File | ForEach-Object {
            [pscustomobject]@{Name=$_.Name; SHA256=(Get-FileHash $_.FullName).Hash; Bytes=$_.Length}
        } | ConvertTo-Json | Set-Content (Join-Path $out 'binary-hashes.json')
        Start-MpScan -ScanType CustomScan -ScanPath $expanded
    }
    Record-Step 'Run published executables directly' {
        $bin = Join-Path $expanded "considered_v0.1.11_windows_$arch"
        & (Join-Path $bin 'considered.exe') --version
        if ($LASTEXITCODE -ne 0) { throw "considered version failed: $LASTEXITCODE" }
        $fixture = Join-Path $env:RUNNER_TEMP 'considered-scan-fixture'
        New-Item -ItemType Directory -Force $fixture | Out-Null
        'package example' | Set-Content (Join-Path $fixture 'example.go')
        & (Join-Path $bin 'considered-scc.exe') --json --root $fixture
        if ($LASTEXITCODE -ne 0) { throw "considered-scc failed: $LASTEXITCODE" }
        # The upstream validator also launches executables with no arguments.
        $launches = foreach ($name in @('considered', 'considered-scc')) {
            # Own the process handle: Windows PowerShell Start-Process can lose
            # ExitCode for a very short-lived process unless invoked with -Wait.
            $process = New-Object System.Diagnostics.Process
            $process.StartInfo.FileName = Join-Path $bin "$name.exe"
            $process.StartInfo.WorkingDirectory = $fixture
            $process.StartInfo.UseShellExecute = $false
            $process.StartInfo.RedirectStandardOutput = $true
            $process.StartInfo.RedirectStandardError = $true
            [void]$process.Start()
            $stdout = $process.StandardOutput.ReadToEndAsync()
            $stderr = $process.StandardError.ReadToEndAsync()
            if (-not $process.WaitForExit(30000)) { $process.Kill(); throw "$name no-argument launch timed out" }
            $stdout.GetAwaiter().GetResult() | Set-Content (Join-Path $out "$name-no-args.stdout.txt")
            $stderr.GetAwaiter().GetResult() | Set-Content (Join-Path $out "$name-no-args.stderr.txt")
            [pscustomobject]@{Executable=$name; ExitCode=$process.ExitCode}
            $process.Dispose()
        }
        ConvertTo-Json -InputObject @($launches) | Set-Content (Join-Path $out 'no-argument-launches.json')
    }
    Record-Step 'Install original manifest through WinGet' {
        if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
            Install-Module Microsoft.WinGet.Client -RequiredVersion 1.29.280 -Force -Repository PSGallery -Scope CurrentUser
            Import-Module Microsoft.WinGet.Client
            Repair-WinGetPackageManager -AllUsers -Version v1.29.290 -Verbose
            $env:PATH += ";$env:LOCALAPPDATA\Microsoft\WindowsApps"
        }
        & winget --info
        if ($LASTEXITCODE -ne 0) { throw 'WinGet unavailable' }
        & winget settings --enable LocalManifestFiles
        if ($LASTEXITCODE -ne 0) { throw 'Unable to enable local manifests' }
        $manifest = Join-Path $out 'manifest'
        New-Item -ItemType Directory -Force $manifest | Out-Null
        $manifestBase = 'https://raw.githubusercontent.com/quitepicky/winget-pkgs/' +
            'ac7f5565afba745a411fd551423525c1bd4791c3/manifests/q/QuitePicky/Considered/0.1.11'
        foreach ($suffix in @('yaml', 'installer.yaml', 'locale.en-US.yaml')) {
            $name = "QuitePicky.Considered.$suffix"
            Invoke-WebRequest "$manifestBase/$name" -OutFile (Join-Path $manifest $name)
        }
        & winget validate --manifest $manifest
        # 0x8A150028 is explicitly 'validation succeeded with warning'. Preserve
        # its output, but do not let schema-comment warnings prevent installation.
        if ($LASTEXITCODE -notin @(0, -1978335192)) { throw "Manifest validation failed: $LASTEXITCODE" }
        & winget install --manifest $manifest --accept-package-agreements --accept-source-agreements --disable-interactivity --verbose-logs
        if ($LASTEXITCODE -ne 0) { throw "WinGet installation failed: $LASTEXITCODE" }
        $links = Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet\Links'
        $env:PATH = "$links;$env:PATH"
        & considered --version
        if ($LASTEXITCODE -ne 0) { throw "Installed considered failed: $LASTEXITCODE" }
        Start-MpScan -ScanType CustomScan -ScanPath (Join-Path $env:LOCALAPPDATA 'Microsoft\WinGet')
    }
    Record-Step 'Standard-user installation' {
        & "$PSScriptRoot/windows-standard-user.ps1" -Manifest (Join-Path $out 'manifest') -Evidence $out
    }
} finally {
    Record-Step 'Capture Defender findings' {
        Get-MpComputerStatus | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $out 'defender-after.json')
        $detections = @(Get-MpThreatDetection)
        ConvertTo-Json -InputObject $detections -Depth 8 | Set-Content (Join-Path $out 'defender-detections.json')
        ConvertTo-Json -InputObject @(Get-MpThreat) -Depth 8 | Set-Content (Join-Path $out 'defender-threats.json')
        if ($detections.Count -gt 0) { $failures.Add('Defender reported threat detections; see evidence.') }
    }
    # Absence of events is normal; command errors are recorded in the transcript.
    Get-WinEvent -FilterHashtable @{LogName='Microsoft-Windows-Windows Defender/Operational'; StartTime=$started} -ErrorAction Continue |
        Select-Object TimeCreated, Id, LevelDisplayName, Message |
        ConvertTo-Json -Depth 6 | Set-Content (Join-Path $out 'defender-events.json')
    foreach ($logs in @(
        "$env:LOCALAPPDATA\Packages\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\LocalState\DiagOutputDir",
        "$env:LOCALAPPDATA\Microsoft\WinGet\DiagOutputDir"
    )) {
        if (Test-Path $logs) { Copy-Item $logs (Join-Path $out ([guid]::NewGuid().ToString())) -Recurse }
    }
    ConvertTo-Json -InputObject $failures.ToArray() | Set-Content (Join-Path $out 'failures.json')
    Stop-Transcript
}
if ($failures.Count -gt 0) { throw ($failures -join "`n") }
