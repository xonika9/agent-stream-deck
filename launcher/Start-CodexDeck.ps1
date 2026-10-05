param(
  [switch]$DryRun,
  [switch]$ForceRestart,
  [switch]$InstallStartup,
  [switch]$UninstallStartup
)

$ErrorActionPreference = 'Stop'

if ($InstallStartup -and $UninstallStartup) {
  throw 'Use either -InstallStartup or -UninstallStartup, not both.'
}

function Get-StartupShortcutPath {
  Join-Path ([Environment]::GetFolderPath('Startup')) 'Codex Deck.lnk'
}

function Get-WatcherStopPath {
  Join-Path (Join-Path $env:LOCALAPPDATA 'CodexDeck') 'watcher.stop'
}

function Get-InstalledLauncherRoot {
  Join-Path (Join-Path $env:LOCALAPPDATA 'CodexDeck') 'launcher'
}

function Request-WatcherStop {
  $ownedPath = [regex]::Escape((Join-Path (Get-InstalledLauncherRoot) 'Watch-CodexDeck.ps1'))
  $ownedProcesses = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -ieq 'powershell.exe' -and [string]$_.CommandLine -match ('(?i)(?:^|\s)-File\s+"?' + $ownedPath + '"?(?:\s|$)')
  })
  $stopPath = Get-WatcherStopPath
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $stopPath) | Out-Null
  [IO.File]::WriteAllText($stopPath, [DateTimeOffset]::UtcNow.ToString('o'), [Text.UTF8Encoding]::new($false))
  $deadline = (Get-Date).AddSeconds(30)
  do {
    $mutex = [Threading.Mutex]::new($false, 'Local\CodexDeckBridgeWatcher')
    $acquired = $false
    try {
      try { $acquired = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $acquired = $true }
      if ($acquired) {
        $stillOwned = @($ownedProcesses | Where-Object {
          $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($_.ProcessId)"
          $null -ne $current -and $current.CreationDate -eq $_.CreationDate
        })
        if ($stillOwned.Count -eq 0) { return }
      }
    } finally {
      if ($acquired) { $mutex.ReleaseMutex() }
      $mutex.Dispose()
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw 'The owned watcher did not release its mutex; no launcher files were replaced and the stop marker remains.'
}

function Get-WatcherBundle {
  $sourceRoot = [IO.Path]::GetFullPath($PSScriptRoot).TrimEnd('\')
  $runtimeSource = Join-Path $sourceRoot 'runtime-override.mjs'
  if (-not (Test-Path -LiteralPath $runtimeSource)) {
    $runtimeSource = Join-Path $sourceRoot '..\release\codex-deck-launcher\runtime-override.mjs'
  }
  $wsSource = Join-Path $sourceRoot 'node_modules\ws'
  if (-not (Test-Path -LiteralPath $wsSource)) { $wsSource = Join-Path $sourceRoot '..\node_modules\ws' }
  foreach ($required in @(
    (Join-Path $sourceRoot 'Start-CodexDeck.ps1'),
    (Join-Path $sourceRoot 'Watch-CodexDeck.ps1'),
    $runtimeSource,
    (Join-Path $wsSource 'package.json'),
    (Join-Path $wsSource 'wrapper.mjs')
  )) {
    if (-not (Test-Path -LiteralPath $required)) { throw "Required launcher component not found: $required" }
  }
  $node = Get-Command node -ErrorAction Stop
  $major = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
  if ($major -lt 24) { throw 'Node.js 24 or newer is required; the installed watcher was not stopped.' }
  $bundle = [pscustomobject]@{ SourceRoot = $sourceRoot; Runtime = $runtimeSource; Ws = $wsSource }
  $preflightRoot = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString('N'))
  try {
    Install-WatcherBundle $bundle $preflightRoot | Out-Null
    $runtimePath = Join-Path $preflightRoot 'runtime-override.mjs'
    & $node.Source --input-type=module -e "await import('node:url').then(m => import(m.pathToFileURL(process.argv[2]).href))" codex-deck-preflight $runtimePath
    if ($LASTEXITCODE -ne 0) { throw 'The autonomous launcher runtime cannot load; the installed watcher was not stopped.' }
    $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    & $powerShellPath -NoLogo -NoProfile -ExecutionPolicy Bypass -File (Join-Path $preflightRoot 'Watch-CodexDeck.ps1') -SelfTest | Out-Host
    if ($LASTEXITCODE -ne 0) { throw 'The watcher self-test failed; the installed watcher was not stopped.' }
    [pscustomobject]@{
      SourceRoot = $preflightRoot
      Runtime = Join-Path $preflightRoot 'runtime-override.mjs'
      Ws = Join-Path $preflightRoot 'node_modules\ws'
    }
  } catch {
    Remove-Item -LiteralPath $preflightRoot -Recurse -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Remove-RetiredBundleFiles([string]$Root) {
  foreach ($obsolete in @('Configure-CodexDeckRelay.ps1', 'Configure-CodexDeckMobile.ps1', 'mobile-pairing.mjs')) {
    $path = Join-Path $Root $obsolete
    if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction Stop }
  }
}

function Install-WatcherBundle($Bundle, [string]$Destination = (Get-InstalledLauncherRoot)) {
  if ($Bundle.SourceRoot.Equals([IO.Path]::GetFullPath($Destination).TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)) {
    Remove-RetiredBundleFiles $Destination
    return $Destination
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $Destination 'node_modules') | Out-Null
  foreach ($filename in @('Start-CodexDeck.ps1', 'Watch-CodexDeck.ps1', 'README.txt')) {
    $source = Join-Path $Bundle.SourceRoot $filename
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination (Join-Path $Destination $filename) -Force }
  }
  Copy-Item -LiteralPath $Bundle.Runtime -Destination (Join-Path $Destination 'runtime-override.mjs') -Force
  $wsDestination = Join-Path $Destination 'node_modules\ws'
  Remove-Item -LiteralPath $wsDestination -Recurse -Force -ErrorAction SilentlyContinue
  Copy-Item -LiteralPath $Bundle.Ws -Destination $wsDestination -Recurse -Force
  Remove-RetiredBundleFiles $Destination
  return $Destination
}

function Start-BridgeWatcher([string]$LauncherRoot = $PSScriptRoot) {
  $watcherPath = Join-Path $LauncherRoot 'Watch-CodexDeck.ps1'
  if (-not (Test-Path -LiteralPath $watcherPath)) { throw "Codex Deck watcher not found: $watcherPath" }
  $powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $readyPath = Join-Path (Join-Path $env:LOCALAPPDATA 'CodexDeck') 'watcher-ready.json'
  $startupToken = [Guid]::NewGuid().ToString('N')
  $watcher = Start-Process -FilePath $powerShellPath -WindowStyle Hidden -PassThru -ArgumentList @(
    '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', "`"$watcherPath`"", '-StartupToken', $startupToken
  )
  $deadline = (Get-Date).AddSeconds(15)
  do {
    $watcher.Refresh()
    if ($watcher.HasExited) { throw 'The new watcher exited before confirming startup.' }
    if (Test-Path -LiteralPath $readyPath) {
      try {
        $ready = Get-Content -LiteralPath $readyPath -Raw | ConvertFrom-Json
        if ($ready.pid -eq $watcher.Id -and $ready.token -ceq $startupToken) { return }
      } catch { }
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  throw 'The new watcher did not confirm startup.'

}

function Stop-LegacyRelayTunnel {
  $stateRoot = Join-Path $env:LOCALAPPDATA 'CodexDeck'
  $pidPath = Join-Path $stateRoot 'relay-tunnel.pid'
  if (-not (Test-Path -LiteralPath $pidPath)) { return }
  try {
    $savedPid = [int](Get-Content -LiteralPath $pidPath -Raw).Trim()
    if ($savedPid -le 0) { throw 'invalid PID' }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid"
    if ($null -eq $process) { Remove-Item -LiteralPath $pidPath -Force; return }
    $config = Get-Content -LiteralPath (Join-Path $stateRoot 'relay-client.json') -Raw | ConvertFrom-Json
    if ($process.Name -ine 'ssh.exe' -or [string]$config.sshHost -notmatch '^[A-Za-z0-9._-]+$' -or
        [string]$config.url -notmatch '^ws://127\.0\.0\.1:(\d+)$') { throw 'unproven ownership' }
    $urlPort = [int]$Matches[1]
    $localPort = if ($null -ne $config.localPort) { [int]$config.localPort } else { $urlPort }
    $remotePort = if ($null -ne $config.remotePort) { [int]$config.remotePort } else { $localPort }
    if ($localPort -ne $urlPort -or $localPort -lt 1024 -or $localPort -gt 65535 -or $remotePort -lt 1024 -or $remotePort -gt 65535) { throw 'invalid saved ports' }
    $expected = '-N -T -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -L ' +
      "127.0.0.1:${localPort}:127.0.0.1:${remotePort} " + [string]$config.sshHost
    # Permit only the documented executable token and exact legacy arguments.
    if ([string]$process.CommandLine -notmatch '^(?:"[^"\r\n]*[\\/]ssh\.exe"|[^"\s]*ssh(?:\.exe)?)\s+(.+)$' -or $Matches[1] -cne $expected) { throw 'unproven command ownership' }
    Stop-Process -Id $savedPid -Force -ErrorAction Stop
    Wait-Process -Id $savedPid -Timeout 10 -ErrorAction SilentlyContinue
    if (Get-Process -Id $savedPid -ErrorAction SilentlyContinue) { throw 'owned tunnel did not stop' }
    Remove-Item -LiteralPath $pidPath -Force
  } catch {
    throw 'Legacy relay migration incomplete: saved tunnel ownership or shutdown could not be confirmed. Inspect the saved relay PID manually; private settings were preserved.'
  }
}

function Set-StartupShortcut {
  $bundle = Get-WatcherBundle
  $oldWatcherStopped = $false
  try {
    Request-WatcherStop
    $oldWatcherStopped = $true
    Stop-LegacyRelayTunnel
    $launcherRoot = Install-WatcherBundle $bundle
    $shortcutPath = Get-StartupShortcutPath
    $watcherPath = Join-Path $launcherRoot 'Watch-CodexDeck.ps1'
    if (-not (Test-Path -LiteralPath $watcherPath)) { throw "Codex Deck watcher not found: $watcherPath" }
    $stopPath = Get-WatcherStopPath
    Remove-Item -LiteralPath $stopPath -Force -ErrorAction SilentlyContinue
    $shell = New-Object -ComObject WScript.Shell
    $shortcut = $shell.CreateShortcut($shortcutPath)
    $shortcut.TargetPath = (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe')
    $shortcut.Arguments = "-NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watcherPath`" -RecoverExistingSession"
    $shortcut.WorkingDirectory = $launcherRoot
    $shortcut.Description = 'Keep the Codex Deck bridge available while Codex is running'
    $shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,44"
    $shortcut.Save()
    Start-BridgeWatcher $launcherRoot
    Write-Host "Startup shortcut installed: $shortcutPath"
    Write-Host "Durable launcher installed: $launcherRoot"
    Write-Host 'The background watcher is running. An existing normal Codex session was not restarted.'
  } catch {
    if (-not $oldWatcherStopped) { throw }
    throw "Watcher update partially failed after stopping the old watcher; old relay tunnels were not restarted. $($_.Exception.Message)"
  } finally { Remove-Item -LiteralPath $bundle.SourceRoot -Recurse -Force -ErrorAction SilentlyContinue }
}

if ($InstallStartup) {
  Set-StartupShortcut
  exit 0
}

if ($UninstallStartup) {
  $shortcutPath = Get-StartupShortcutPath
  Request-WatcherStop
  if (Test-Path -LiteralPath $shortcutPath) {
    Remove-Item -LiteralPath $shortcutPath -Force
    Write-Host "Startup shortcut removed: $shortcutPath"
  } else {
    Write-Host 'No Codex Deck startup shortcut was installed.'
  }
  $installedRoot = Get-InstalledLauncherRoot
  if (Test-Path -LiteralPath $installedRoot) {
    Remove-Item -LiteralPath $installedRoot -Recurse -Force
    Write-Host "Durable launcher removed: $installedRoot"
  }
  exit 0
}

function Get-CodexInstallation {
  $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
    Sort-Object Version -Descending |
    Select-Object -First 1
  if ($null -eq $package -or [string]::IsNullOrWhiteSpace($package.InstallLocation)) {
    throw 'The OpenAI Codex Windows app is not installed.'
  }
  $appRoot = Join-Path $package.InstallLocation 'app'
  $executable = Join-Path $appRoot 'ChatGPT.exe'
  if (-not (Test-Path -LiteralPath $executable)) { throw "Codex executable not found: $executable" }
  [pscustomobject]@{ Root = [IO.Path]::GetFullPath($appRoot).TrimEnd('\'); Executable = $executable; Version = $package.Version.ToString() }
}

function Get-CodexProcesses([string]$AppRoot) {
  $prefix = $AppRoot.TrimEnd('\') + '\'
  @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
    $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  })
}

function Get-HealthyDebugPort($Processes) {
  foreach ($process in $Processes) {
    if ([string]::IsNullOrWhiteSpace($process.CommandLine)) { continue }
    if ($process.CommandLine -match '--remote-debugging-port=(\d+)') {
      $candidate = [int]$Matches[1]
      try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$candidate/json/version" -TimeoutSec 1
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) { return $candidate }
      }
      catch { }
    }
  }
  return $null
}

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) { throw 'Node.js 24 or newer is required. Install it from https://nodejs.org/ and try again.' }
$major = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
if ($major -lt 24) { throw "Node.js 24 or newer is required. Found: $(& $node.Source --version)" }

$bundle = Get-WatcherBundle
try {
  $codex = Get-CodexInstallation
  $processes = Get-CodexProcesses $codex.Root
  $existingPort = Get-HealthyDebugPort $processes
  if ($DryRun) {
    Write-Host "Codex version: $($codex.Version)"
    Write-Host "Executable: $($codex.Executable)"
    Write-Host "Node: $(& $node.Source --version)"
    if ($existingPort) { Write-Host "Reusable debug port: $existingPort" }
    elseif ($processes.Count -gt 0) { Write-Host 'Codex is running without a reusable debug bridge; a restart is required.' }
    else { Write-Host 'Codex is not running; the launcher will start it.' }
    exit 0
  }

  $port = $existingPort
  if ($ForceRestart -or -not $port) {
    if ($processes.Count -gt 0) {
    Write-Host "Closing $($processes.Count) Codex process(es)..."
    foreach ($process in ($processes | Sort-Object ParentProcessId -Descending)) {
      Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    $deadline = (Get-Date).AddSeconds(10)
    do { Start-Sleep -Milliseconds 250; $remaining = Get-CodexProcesses $codex.Root }
    while ($remaining.Count -gt 0 -and (Get-Date) -lt $deadline)
    if ($remaining.Count -gt 0) { throw 'Some Codex background processes could not be closed.' }
    }

    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start()
    $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port
    $listener.Stop()
  }

  if ($existingPort -and -not $ForceRestart) {
    Write-Host "Reusing the existing Codex session on loopback port $port..."
  }
  else {
    Write-Host "Starting Codex $($codex.Version) with a loopback-only bridge on port $port..."
    Start-Process -FilePath $codex.Executable -ArgumentList @(
      '--remote-debugging-address=127.0.0.1',
      "--remote-debugging-port=$port"
    )
  }

  $stateRoot = Join-Path $env:LOCALAPPDATA 'CodexDeck'
  $statePath = Join-Path $stateRoot 'codex-micro-bridge.json'
  New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
  [IO.File]::WriteAllText(
    $statePath,
    (@{ port = $port; updatedAt = [DateTimeOffset]::UtcNow.ToString('o') } | ConvertTo-Json -Compress),
    [Text.UTF8Encoding]::new($false)
  )

  $runtimeScript = $bundle.Runtime

  & $node.Source $runtimeScript $port
  if ($LASTEXITCODE -ne 0) { throw 'The Codex Micro runtime could not be enabled.' }

  Write-Host 'Codex Deck is ready. Keep this Codex session open while using Stream Deck.'
} finally { Remove-Item -LiteralPath $bundle.SourceRoot -Recurse -Force -ErrorAction SilentlyContinue }
