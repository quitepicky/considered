param([Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference = 'Stop'
$scanRequested = Get-Date
Write-Host "Starting full post-install scan at $scanRequested"
try {
Start-MpScan -ScanType FullScan
$deadline = $scanRequested.AddMinutes(65)
do {
    $status = Get-MpComputerStatus
    if ($status.FullScanStartTime -ge $scanRequested.AddSeconds(-2) -and
        $status.FullScanEndTime -ge $status.FullScanStartTime) {
        $status | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Evidence 'full-scan-completed.json')
        Write-Host "Full scan completed at $($status.FullScanEndTime)"
        break
    }
    if ((Get-Date) -gt $deadline) { throw 'Full Defender scan did not complete within 65 minutes' }
    Start-Sleep -Seconds 15
} while ($true)
} finally {
    $status = Get-MpComputerStatus
    $status | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Evidence 'full-scan-status.json')
    $detections = @(Get-MpThreatDetection)
    ConvertTo-Json -InputObject $detections -Depth 8 | Set-Content (Join-Path $Evidence 'full-scan-detections.json')
    ConvertTo-Json -InputObject @(Get-MpThreat) -Depth 8 | Set-Content (Join-Path $Evidence 'full-scan-threats.json')
    Get-WinEvent -FilterHashtable @{
        LogName='Microsoft-Windows-Windows Defender/Operational'; StartTime=$scanRequested
    } -ErrorAction Continue | Select-Object TimeCreated, Id, Message |
        ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Evidence 'full-scan-events.json')
}
if (-not $status.AntivirusEnabled -or -not $status.RealTimeProtectionEnabled) { throw 'Defender protection inactive' }
if ($detections.Count -gt 0) { throw 'Full-scan threat findings require investigation; see artifacts.' }
