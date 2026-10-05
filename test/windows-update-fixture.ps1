param([string]$Repository)
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $Repository 'launcher\Start-CodexDeck.ps1'), [ref]$tokens, [ref]$errors)
if ($errors.Count) { throw 'Launcher parser errors' }
foreach ($function in $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] }, $false)) {
  Invoke-Expression $function.Extent.Text
}
$fixture = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixture | Out-Null
$originalLocalAppData = $env:LOCALAPPDATA
try {
  $env:LOCALAPPDATA = $fixture
  $state = Join-Path $fixture 'CodexDeck'
  New-Item -ItemType Directory -Path $state | Out-Null
  # Model unknown live SSH using the real migrator, not a JS port of its logic.
  function Get-CimInstance { [pscustomobject]@{ Name = 'ssh.exe'; CommandLine = 'ssh.exe -N -L 127.0.0.1:40000:127.0.0.1:40000 unknown' } }
  function Stop-Process { throw 'Unknown SSH must never be stopped' }
  [IO.File]::WriteAllText((Join-Path $state 'relay-tunnel.pid'), '1234')
  $privateConfig = '{"sshHost":"saved-alias","url":"ws://127.0.0.1:47651","token":"fixture-private"}'
  [IO.File]::WriteAllText((Join-Path $state 'relay-client.json'), $privateConfig)
  $failed = $false
  try { Stop-LegacyRelayTunnel } catch { $failed = $_.Exception.Message -match 'migration incomplete' }
  if (-not $failed) { throw 'Unproven ownership must reject migration' }
  if ((Get-Content -LiteralPath (Join-Path $state 'relay-client.json') -Raw) -cne $privateConfig) { throw 'Private settings changed' }
  $script:stoppedOwned = $false
  function Get-CimInstance { [pscustomobject]@{ Name = 'ssh.exe'; CommandLine = 'ssh.exe -N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L 127.0.0.1:47651:127.0.0.1:47651 saved-alias' } }
  function Stop-Process { $script:stoppedOwned = $true }
  function Wait-Process { }
  function Get-Process { $null }
  Stop-LegacyRelayTunnel
  if (-not $script:stoppedOwned -or (Test-Path (Join-Path $state 'relay-tunnel.pid'))) { throw 'Proven owned tunnel was not retired' }
  if ((Get-Content -LiteralPath (Join-Path $state 'relay-client.json') -Raw) -cne $privateConfig) { throw 'Owned cleanup changed private settings' }
  $source = Join-Path $fixture 'source'
  New-Item -ItemType Directory -Path $source | Out-Null
  foreach ($name in @('Start-CodexDeck.ps1', 'Watch-CodexDeck.ps1')) { Copy-Item (Join-Path $Repository "launcher/$name") (Join-Path $source $name) }
  $fallback = Join-Path $fixture 'release/codex-deck-launcher'
  New-Item -ItemType Directory -Path $fallback -Force | Out-Null
  # Exercise the actual autonomous CLI bundle, including its entry-point guard.
  & node --input-type=module -e 'import { build } from "esbuild"; await build({entryPoints:[process.argv[1]],outfile:process.argv[2],bundle:true,external:["ws"],platform:"node",format:"esm",target:"node24"});' (Join-Path $Repository 'launcher/runtime-override.ts') (Join-Path $fallback 'runtime-override.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'Fixture runtime build failed' }
  New-Item -ItemType Directory -Path (Join-Path $fixture 'node_modules') | Out-Null
  Copy-Item (Join-Path $Repository 'node_modules/ws') (Join-Path $fixture 'node_modules/ws') -Recurse
  $originalScriptRoot = $PSScriptRoot
  $originalSystemRoot = $env:SystemRoot
  if ($IsWindows -eq $false) {
    $env:SystemRoot = Join-Path $fixture 'system'
    $shim = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    New-Item -ItemType Directory -Path (Split-Path $shim -Parent) -Force | Out-Null
    [IO.File]::WriteAllText($shim, ("#!/bin/sh`nexec '" + (Join-Path $PSHOME 'pwsh') + "' `"`$@`"`n"))
    & /bin/chmod 755 $shim
  }
  try {
    $bundleFunction = $ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-WatcherBundle' }, $false)[0]
    # AST extraction has no file-backed automatic script root; bind only that
    # intrinsic path to the fixture, retaining the executed function body.
    Invoke-Expression ($bundleFunction.Extent.Text.Replace('$PSScriptRoot', ("'" + $source.Replace("'", "''") + "'")))
    $prepared = Get-WatcherBundle
    if (-not (Test-Path (Join-Path $prepared.SourceRoot 'node_modules/ws/lib/websocket.js'))) { throw 'Split fallback bundle was not assembled' }
    Remove-Item -LiteralPath $prepared.SourceRoot -Recurse -Force
    Remove-Item -LiteralPath (Join-Path $fixture 'node_modules/ws/lib/websocket.js') -Force
    $failed = $false
    try { Get-WatcherBundle | Out-Null } catch { $failed = $_.Exception.Message -match 'runtime cannot load' }
    if (-not $failed) { throw 'Broken autonomous dependency must fail before watcher stop' }
  } finally { $PSScriptRoot = $originalScriptRoot; $env:SystemRoot = $originalSystemRoot }
  # Execute the actual readiness consumer against the OS process boundary.
  $readyPath = Join-Path $state 'watcher-ready.json'
  $readySystemRoot = $env:SystemRoot
  $env:SystemRoot = $fixture
  try {
    function Start-Process {
      param($FilePath, $WindowStyle, [switch]$PassThru, $ArgumentList)
      $process = [pscustomobject]@{ Id = 555; HasExited = ($script:readyScenario -eq 'exited') }
      $process | Add-Member -MemberType ScriptMethod -Name Refresh -Value { }
      if ($script:readyScenario -ne 'missing') {
        $token = if ($script:readyScenario -eq 'stale') { 'old-startup-token' } else { $ArgumentList[-1] }
        [IO.File]::WriteAllText($readyPath, (@{ pid = 555; token = $token } | ConvertTo-Json -Compress))
      }
      return $process
    }
    function Get-Date {
      $script:readyClockCalls++
      if ($script:readyClockCalls -eq 1) { return [DateTime]::UtcNow }
      return [DateTime]::UtcNow.AddMinutes(1)
    }
    foreach ($scenario in @('current', 'stale', 'exited', 'missing')) {
      $script:readyScenario = $scenario
      $script:readyClockCalls = 0
      Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue
      $failure = ''
      try { Start-BridgeWatcher $source } catch { $failure = $_.Exception.Message }
      if ($scenario -eq 'current' -and $failure) { throw "Fresh readiness was rejected: $failure" }
      if ($scenario -in @('stale', 'missing') -and $failure -notmatch 'did not confirm startup') { throw "Invalid readiness accepted: $scenario" }
      if ($scenario -eq 'exited' -and $failure -notmatch 'exited before confirming startup') { throw 'Exited watcher was accepted' }
    }
    Write-Host 'Watcher readiness fixture passed (4 cases; mocked process boundary).'
  } finally {
    Remove-Item Function:Start-Process, Function:Get-Date
    $env:SystemRoot = $readySystemRoot
  }
  # A separate real process holds the named mutex longer than the updater limit.
  $holderPath = Join-Path $fixture 'holder.ps1'
  $heldPath = Join-Path $fixture 'held'
  [IO.File]::WriteAllText($holderPath, ('$m = [Threading.Mutex]::new($true, "Local\CodexDeckBridgeWatcher"); [IO.File]::WriteAllText("' + $heldPath + '", "held"); Start-Sleep -Seconds 40; $m.ReleaseMutex(); $m.Dispose()'))
  $interpreter = if ($IsWindows -eq $false) { Join-Path $PSHOME 'pwsh' } else { Join-Path $PSHOME 'powershell.exe' }
  $holder = Start-Process -FilePath $interpreter -ArgumentList @('-NoProfile', '-File', $holderPath) -PassThru
  try {
    $deadline = (Get-Date).AddSeconds(5)
    while (-not (Test-Path $heldPath) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 50 }
    if (-not (Test-Path $heldPath)) { throw 'Fixture mutex holder failed' }
    $failed = $false
    try { Request-WatcherStop } catch { $failed = $_.Exception.Message -match 'did not release its mutex' }
    if (-not $failed -or -not (Test-Path (Join-Path $state 'watcher.stop'))) { throw 'Busy old watcher must time out with stop marker retained' }
  } finally { Microsoft.PowerShell.Management\Stop-Process -Id $holder.Id -Force -ErrorAction SilentlyContinue }
  foreach ($name in @('Configure-CodexDeckRelay.ps1', 'Configure-CodexDeckMobile.ps1', 'mobile-pairing.mjs', 'retained.txt')) { [IO.File]::WriteAllText((Join-Path $fixture $name), 'fixture') }
  Install-WatcherBundle ([pscustomobject]@{ SourceRoot = $fixture }) $fixture | Out-Null
  if (Test-Path (Join-Path $fixture 'Configure-CodexDeckRelay.ps1')) { throw 'Same-root update retained retired script' }
  if (-not (Test-Path (Join-Path $fixture 'retained.txt'))) { throw 'Unrelated file deleted' }
  Write-Host 'Windows update ownership and same-root cleanup fixture passed.'
} finally {
  $env:LOCALAPPDATA = $originalLocalAppData
  Remove-Item -LiteralPath $fixture -Recurse -Force
}
