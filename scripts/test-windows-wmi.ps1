param([Parameter(Mandatory)][string]$EvidenceDirectory)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $EvidenceDirectory | Out-Null
$result = [ordered]@{
    powershell = $PSVersionTable.PSVersion.ToString()
    runtime = [System.Runtime.InteropServices.RuntimeInformation]::FrameworkDescription
    osArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    processArchitecture = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
    status = 'not-run'
    error = $null
}
$searcher = $null
$processes = $null
try {
    # Exercise the .NET Framework WMI API mentioned in the validator's cleanup
    # exception. This is read-only; do not terminate any processes.
    Add-Type -AssemblyName System.Management
    $searcher = New-Object System.Management.ManagementObjectSearcher('SELECT ProcessId FROM Win32_Process')
    $processes = $searcher.Get()
    $result.processCount = $processes.Count
    $result.status = 'passed'
} catch {
    $result.status = 'failed'
    $result.error = $_.Exception.ToString()
} finally {
    if ($null -ne $processes) { $processes.Dispose() }
    if ($null -ne $searcher) { $searcher.Dispose() }
    $result | ConvertTo-Json -Depth 6 | Tee-Object -FilePath (Join-Path $EvidenceDirectory 'wmi.json')
}
# Diagnostic only: record environment failure separately from application probes.
