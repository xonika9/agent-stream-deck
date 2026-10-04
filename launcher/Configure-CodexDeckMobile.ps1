[CmdletBinding()]
param(
  [ValidateRange(1024, 65535)][int]$Port = 47652,
  [ValidateRange(1024, 65535)][int]$LocalPort = 47653,
  [switch]$Local,
  [switch]$Rotate,
  [switch]$Disable
)

$ErrorActionPreference = 'Stop'
$stateRoot = Join-Path $env:LOCALAPPDATA 'CodexDeck'
$configPath = Join-Path $stateRoot 'mobile-relay-server.json'
$localConfigPath = Join-Path $stateRoot 'mobile-local-relay-server.json'
$localQrPath = Join-Path $stateRoot 'mobile-local-pairing.svg'

if ($Local) {
  if ($Disable) {
    Remove-Item -LiteralPath $localConfigPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $localQrPath -Force -ErrorAction SilentlyContinue
    Write-Host 'Nearby iPhone discovery disabled. Reload only the Codex Deck Stream Deck plugin.'
    exit 0
  }
  $node = Get-Command node -ErrorAction SilentlyContinue
  if ($null -eq $node) { throw 'Node.js 24 or newer is required for secure local pairing.' }
  $major = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
  if ($major -lt 24) { throw 'Node.js 24 or newer is required for secure local pairing.' }
  $helper = Join-Path $PSScriptRoot 'mobile-pairing.mjs'
  if (-not (Test-Path -LiteralPath $helper)) {
    $helper = Join-Path $PSScriptRoot '..\release\codex-deck-launcher\mobile-pairing.mjs'
  }
  if (-not (Test-Path -LiteralPath $helper)) { throw 'The bundled mobile-pairing.mjs helper is missing.' }
  $arguments = @($helper, '--state-root', $stateRoot, '--port', $LocalPort)
  if ($Rotate) { $arguments += '--rotate' }
  $result = (& $node.Source @arguments | ConvertFrom-Json)
  if ($LASTEXITCODE -ne 0) { throw 'Secure nearby pairing configuration failed.' }
  Write-Host "Nearby iPhone node configured on $($result.address):$($result.port)."
  Write-Host 'Reload only the Codex Deck Stream Deck plugin, then scan the QR code with the iPhone Camera.'
  Write-Host 'If Windows Firewall asks, allow Node.js on Private networks only. Do not enable Public networks.'
  if (-not $Rotate) { Write-Host 'Running this command again reopens the same pairing identity; use -Rotate only to replace it.' }
  Start-Process -FilePath $result.qrPath
  exit 0
}

if ($Disable) {
  Remove-Item -LiteralPath $configPath -Force -ErrorAction SilentlyContinue
  Write-Host 'iPhone relay disabled. Reload only the Codex Deck Stream Deck plugin.'
  Write-Host "If Tailscale Serve was configured for this port, disable that mapping separately with: tailscale serve --https=$Port off"
  exit 0
}

New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
$bytes = [byte[]]::new(32)
$random = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $random.GetBytes($bytes) }
finally { $random.Dispose() }
$token = [Convert]::ToBase64String($bytes)
$config = [ordered]@{
  enabled = $true
  listenHost = '127.0.0.1'
  port = $Port
  token = $token
}
$temporary = "$configPath.$PID.tmp"
[IO.File]::WriteAllText($temporary, (($config | ConvertTo-Json) + "`n"), [Text.UTF8Encoding]::new($false))
Move-Item -LiteralPath $temporary -Destination $configPath -Force

Write-Host "iPhone relay configured on 127.0.0.1:$Port. Reload only the Codex Deck Stream Deck plugin."
Write-Host "Then expose it privately with: tailscale serve --bg --https=$Port http://127.0.0.1:$Port"
Write-Host 'Pair the iPhone app with the wss:// URL printed by Tailscale and this token:'
Write-Host $token
Write-Warning 'Treat the token as a password. Running this command again rotates it.'
