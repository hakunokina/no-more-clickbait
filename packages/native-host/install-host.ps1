<#
.SYNOPSIS
  Registers the No More Clickbait Native Messaging host for Chrome and Brave
  (and, with -IncludeEdge, Microsoft Edge) under HKCU (per-user, no admin
  rights needed).

.DESCRIPTION
  Writes the host manifest to %LOCALAPPDATA%\NoMoreClickbait\ and points the
  per-browser registry keys at it. Run install only after `pnpm build`.
  Remove with -Uninstall. This script is provided for the user to run
  themselves; nothing in the build executes it.

  Vivaldi needs no key of its own: it reads Chrome's NativeMessagingHosts
  key, so the Chrome registration covers it.

.PARAMETER ExtensionId
  The extension's ID. The unpacked extension pins a fixed ID via the
  manifest `key` field, so this defaults to it
  (ojljncfhbebelhbkgjhmfgjodpojmnbe). Pass another ID only if you built
  a differently-keyed extension.

.EXAMPLE
  ./install-host.ps1

.PARAMETER IncludeEdge
  Also register the host for Microsoft Edge. Edge keeps its own key
  (HKCU\Software\Microsoft\Edge\NativeMessagingHosts) and checks it before
  falling back to Chrome's, so register explicitly for Edge. With
  -Uninstall the Edge key is removed whether or not this is passed.

.EXAMPLE
  ./install-host.ps1 -IncludeEdge

.EXAMPLE
  ./install-host.ps1 -ExtensionId abcdefghijklmnopqrstuvwxyz012345
#>
[CmdletBinding()]
param(
  [ValidatePattern('^[a-p]{32}$')]
  [string]$ExtensionId = 'ojljncfhbebelhbkgjhmfgjodpojmnbe',

  [switch]$IncludeEdge,

  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$HostName = 'io.github.hakunokina.no_more_clickbait'
$InstallDir = Join-Path $env:LOCALAPPDATA 'NoMoreClickbait'
$ManifestPath = Join-Path $InstallDir "$HostName.json"

$Browsers = @(
  'HKCU:\Software\Google\Chrome\NativeMessagingHosts',
  'HKCU:\Software\BraveSoftware\Brave-Browser\NativeMessagingHosts'
)
$BrowserNames = @('Chrome', 'Brave')
# Edge is opt-in on install (no key for a browser the user does not use),
# but uninstall always cleans it up.
if ($IncludeEdge -or $Uninstall) {
  $Browsers += 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts'
  $BrowserNames += 'Edge'
}

foreach ($Root in $Browsers) {
  $Key = Join-Path $Root $HostName
  if ($Uninstall) {
    if (Test-Path $Key) { Remove-Item $Key -Force }
  } else {
    if (-not (Test-Path $Root)) { New-Item -Path $Root -Force | Out-Null }
    New-Item -Path $Key -Force | Out-Null
    New-ItemProperty -Path $Key -Name '(Default)' -Value $ManifestPath -Force | Out-Null
  }
}

if ($Uninstall) {
  if (Test-Path $ManifestPath) { Remove-Item $ManifestPath -Force }
  Write-Host "Removed native host registration ($HostName)."
  exit 0
}

$HostCmd = Join-Path $PSScriptRoot 'bin\no-more-clickbait-host.cmd'
if (-not (Test-Path $HostCmd)) { throw "Host launcher not found: $HostCmd" }
$BuiltHost = Join-Path $PSScriptRoot 'dist\main.js'
if (-not (Test-Path $BuiltHost)) { throw "Host not built yet. Run 'pnpm build' first." }

if (-not (Test-Path $InstallDir)) { New-Item -Path $InstallDir -ItemType Directory -Force | Out-Null }

$Manifest = [ordered]@{
  name            = $HostName
  description     = 'No More Clickbait native messaging host'
  path            = $HostCmd
  type            = 'stdio'
  allowed_origins = @("chrome-extension://$ExtensionId/")
}
# BOM-less UTF-8: Windows PowerShell 5.1's `-Encoding utf8` writes a BOM,
# which the browser's manifest JSON parser rejects.
[IO.File]::WriteAllText($ManifestPath, ($Manifest | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))

Write-Host "Native host registered for $($BrowserNames -join ', '):"
Write-Host "  manifest : $ManifestPath"
Write-Host "  host     : $HostCmd"
Write-Host "  extension: chrome-extension://$ExtensionId/"
