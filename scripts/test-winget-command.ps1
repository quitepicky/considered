$ErrorActionPreference = 'Stop'
$tokens = $null
$parseErrors = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot 'test-windows-package.ps1'), [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$definition = $ast.Find({ param($node)
    $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Invoke-WinGetChecked'
}, $true)
if ($null -eq $definition) { throw 'Missing checked WinGet wrapper' }
. ([scriptblock]::Create($definition.Extent.Text))

function global:winget {
    $global:SeenArguments = @($args)
    $global:LASTEXITCODE = $global:FakeExitCode
}
try {
    $global:FakeExitCode = 0
    Invoke-WinGetChecked -Arguments @('install', '--manifest', 'C:\path with spaces', '--disable-interactivity')
    if (($global:SeenArguments -join '|') -ne 'install|--manifest|C:\path with spaces|--disable-interactivity') {
        throw 'Arguments were not forwarded intact'
    }
    $global:FakeExitCode = -1978335192
    Invoke-WinGetChecked -Arguments @('validate', '--manifest', 'fixture') -Validation
    foreach ($code in @(1, -1978335192, -1978335185)) {
        $global:FakeExitCode = $code
        $rejected = $false
        try { Invoke-WinGetChecked -Arguments @('install', '--manifest', 'fixture') } catch { $rejected = $true }
        if (-not $rejected) { throw "Install failure $code was accepted" }
    }
    $global:FakeExitCode = 1
    $rejected = $false
    try { Invoke-WinGetChecked -Arguments @('validate', '--manifest', 'fixture') -Validation } catch { $rejected = $true }
    if (-not $rejected) { throw 'Validation failure was accepted' }
    Write-Output 'WinGet command forwarding and failure handling passed.'
} finally {
    Remove-Item Function:\winget
    Remove-Variable FakeExitCode, SeenArguments -Scope Global
    $global:LASTEXITCODE = 0
}
