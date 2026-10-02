param([Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference = 'Stop'
# GitHub's image builder disables scanning and excludes C:\ and D:\.
# Strengthen this disposable, secret-free VM before any artifact downloads.
$before = Get-MpPreference
$before | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $Evidence 'defender-preferences-before.json')
foreach ($name in @('ExclusionPath', 'ExclusionProcess', 'ExclusionExtension')) {
    if ($before.$name) {
        $remove = @{ $name = $before.$name }
        Remove-MpPreference @remove
    }
}
$settings = @{
    DisableRealtimeMonitoring = $false
    DisableArchiveScanning = $false
    DisableBehaviorMonitoring = $false
    DisableIOAVProtection = $false
    DisableScriptScanning = $false
    DisableBlockAtFirstSeen = $false
    DisableScanningNetworkFiles = $false
    DisableAutoExclusions = $true
    MAPSReporting = 2
    SubmitSamplesConsent = 1
    PUAProtection = 1
    ScanAvgCPULoadFactor = 50
    ScanOnlyIfIdleEnabled = $false
}
Set-MpPreference @settings
$after = Get-MpPreference
$after | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $Evidence 'defender-preferences-active.json')
foreach ($name in $settings.Keys) {
    if ($after.$name -ne $settings[$name]) { throw "Defender preference did not take effect: $name" }
}
foreach ($name in @('ExclusionPath', 'ExclusionProcess', 'ExclusionExtension')) {
    if ($after.$name) { throw "Defender still has exclusions: $name" }
}
