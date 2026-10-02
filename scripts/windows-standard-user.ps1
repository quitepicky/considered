param([Parameter(Mandatory)][string]$Manifest, [Parameter(Mandatory)][string]$Evidence)
$ErrorActionPreference = 'Stop'
$accountName = 'consideredtest'
if (Get-LocalUser -Name $accountName -ErrorAction SilentlyContinue) { throw 'Test account already exists' }
$password = ConvertTo-SecureString ('Aa1!' + [guid]::NewGuid().ToString('N')) -AsPlainText -Force
$account = New-LocalUser -Name $accountName -Password $password -Description 'Disposable installation diagnostic'
$shared = Join-Path $env:PUBLIC ('considered-test-' + [guid]::NewGuid().ToString('N'))
try {
    # Machine policy applies to the fresh account; runner-local admin settings do not.
    # See microsoft/winget-cli doc/admx/DesktopAppInstaller.admx.
    $policy = 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\AppInstaller'
    New-Item -Path $policy -Force | Out-Null
    New-ItemProperty -Path $policy -Name EnableLocalManifestFiles -PropertyType DWord -Value 1 -Force | Out-Null
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account.Name
    New-Item -ItemType Directory $shared | Out-Null
    $acl = Get-Acl $shared
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
        $account.SID, 'Modify', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
    Set-Acl $shared $acl
    Copy-Item $Manifest (Join-Path $shared 'manifest') -Recurse
    Copy-Item "$PSScriptRoot/windows-standard-install.ps1" (Join-Path $shared 'install.ps1')
    $app = Get-AppxPackage -Name Microsoft.DesktopAppInstaller
    if (-not $app) { throw 'WinGet Appx package missing in administrator setup' }
    $app.InstallLocation | Set-Content (Join-Path $shared 'winget-location.txt')
    Get-AppxPackage -PackageTypeFilter Framework | Where-Object {
        $_.Name -match '^Microsoft\.(VCLibs|UI\.Xaml|WindowsAppRuntime)'
    } | Select-Object -ExpandProperty InstallLocation | Set-Content (Join-Path $shared 'frameworks.txt')
    Start-Service seclogon
    $credential = [pscredential]::new("$env:COMPUTERNAME\$accountName", $password)
    $params = @{
        FilePath = "$env:WINDIR\System32\WindowsPowerShell\v1.0\powershell.exe"
        ArgumentList = "-NoProfile -NonInteractive -File `"$shared\install.ps1`""
        Credential = $credential
        LoadUserProfile = $true
        WorkingDirectory = $shared
        PassThru = $true
        RedirectStandardOutput = (Join-Path $shared 'stdout.txt')
        RedirectStandardError = (Join-Path $shared 'stderr.txt')
    }
    $process = Start-Process @params
    if (-not $process.WaitForExit(600000)) {
        $process.Kill()
        throw 'Standard-user test exceeded ten minutes'
    }
    $resultFile = Join-Path $shared 'result.json'
    if (-not (Test-Path $resultFile)) { throw 'Standard-user process did not produce its result' }
    $result = Get-Content $resultFile -Raw | ConvertFrom-Json
    if (-not $result.success -or $result.isAdministrator) { throw "Standard-user test failed: $($result.error)" }
    Write-Host 'Standard-user install, executable discovery, and both CLI smoke tests passed.'
} finally {
    if (Test-Path $shared) { Copy-Item $shared (Join-Path $Evidence 'standard-user') -Recurse }
    Remove-LocalUser -Name $accountName
    # Leave the profile/files in this disposable VM for the subsequent full scan.
}
