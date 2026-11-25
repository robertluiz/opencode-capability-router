[CmdletBinding(SupportsShouldProcess=$true)]
param([string]$ConfigPath, [string]$Destination)
$ErrorActionPreference = 'Stop'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js is required.' }
$argsList = @((Join-Path $PSScriptRoot 'manage.mjs'), 'install', $PSScriptRoot)
if ($ConfigPath) { $argsList += @('--config', $ConfigPath) }
if ($Destination) { $argsList += @('--destination', $Destination) }
if ($PSCmdlet.ShouldProcess('OpenCode plugin configuration and local package', 'Install capability router')) {
    & node @argsList
    if ($LASTEXITCODE -ne 0) { throw "Installation failed (exit $LASTEXITCODE)." }
    Write-Host 'On startup, OpenCode will load the router and register the default indexer if needed.'
}
