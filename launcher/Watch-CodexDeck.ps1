param(
  [switch]$Once,
  [switch]$SelfTest,
  [switch]$RecoverExistingSession,
  [string]$StartupToken = '',
  [ValidateRange(1, 30)]
  [int]$PollSeconds = 2
)

$ErrorActionPreference = 'Stop'

$launcherPath = Join-Path $PSScriptRoot 'Start-CodexDeck.ps1'
$powerShellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$stateRoot = Join-Path $env:LOCALAPPDATA 'CodexDeck'
$statePath = Join-Path $stateRoot 'codex-micro-bridge.json'
$stopPath = Join-Path $stateRoot 'watcher.stop'
$logPath = Join-Path $stateRoot 'watcher.log'
$mutexName = 'Local\CodexDeckBridgeWatcher'

function Test-RecoveryAllowed(
  [string]$Generation,
  [string]$HandledGeneration,
  [bool]$RecoverExisting,
  [bool]$SawStopped,
  [bool]$HadHealthy,
  [DateTimeOffset]$NextRecoveryAt = [DateTimeOffset]::MinValue
) {
  $generationChanged = -not [string]::IsNullOrWhiteSpace($HandledGeneration) -and $Generation -ne $HandledGeneration
  ([DateTimeOffset]::UtcNow -ge $NextRecoveryAt) -and ($RecoverExisting -or $SawStopped -or $HadHealthy -or $generationChanged)
}

if ($SelfTest) {
  $cases = @(
    @{ Name = 'initial existing session remains untouched'; Expected = $false; Actual = Test-RecoveryAllowed 'v1:100' '' $false $false $false },
    @{ Name = 'same process remains untouched'; Expected = $false; Actual = Test-RecoveryAllowed 'v1:100' 'v1:100' $false $false $false },
    @{ Name = 'rapid main-process replacement recovers'; Expected = $true; Actual = Test-RecoveryAllowed 'v1:101' 'v1:100' $false $false $false },
    @{ Name = 'observed stopped interval recovers'; Expected = $true; Actual = Test-RecoveryAllowed 'v1:101' '' $false $true $false },
    @{ Name = 'previous healthy bridge recovers'; Expected = $true; Actual = Test-RecoveryAllowed 'v2:200' 'v1:100' $false $false $true },
    @{ Name = 'new process during global cooldown remains untouched'; Expected = $false; Actual = Test-RecoveryAllowed 'v1:102' 'v1:101' $true $true $true ([DateTimeOffset]::UtcNow.AddMinutes(10)) },
    @{ Name = 'new process after global cooldown may recover'; Expected = $true; Actual = Test-RecoveryAllowed 'v1:103' 'v1:102' $false $false $true ([DateTimeOffset]::UtcNow.AddSeconds(-1)) },
    @{ Name = 'login recovery handles startup race'; Expected = $true; Actual = Test-RecoveryAllowed 'v1:100' '' $true $false $false }
  )
  $failures = @($cases | Where-Object { $_.Actual -ne $_.Expected })
  if ($failures.Count -gt 0) { throw "Watcher self-test failed: $($failures.Name -join ', ')" }
  Write-Host "Codex Deck watcher self-test passed ($($cases.Count) cases)."
  exit 0
}

New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null

function Write-WatcherLog([string]$Message) {
  if (Test-Path -LiteralPath $logPath) {
    $log = Get-Item -LiteralPath $logPath -ErrorAction SilentlyContinue
    if ($null -ne $log -and $log.Length -gt 524288) {
      Move-Item -LiteralPath $logPath -Destination "$logPath.previous" -Force
    }
  }
  $line = "[$([DateTimeOffset]::Now.ToString('o'))] $Message"
  Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
  Write-Host $line
}

function Get-CodexInstallation {
  $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
    Sort-Object Version -Descending |
    Select-Object -First 1
  if ($null -eq $package -or [string]::IsNullOrWhiteSpace($package.InstallLocation)) { return $null }
  $appRoot = Join-Path $package.InstallLocation 'app'
  [pscustomobject]@{
    Root = [IO.Path]::GetFullPath($appRoot).TrimEnd('\')
    Version = $package.Version.ToString()
  }
}

function Get-CodexProcesses([string]$AppRoot) {
  $prefix = $AppRoot.TrimEnd('\') + '\'
  @(Get-CimInstance Win32_Process -ErrorAction Stop | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_.ExecutablePath) -and
    $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
  })
}

function Get-CodexGeneration([string]$Version, $Processes) {
  $main = $Processes |
    Where-Object { $_.Name -ieq 'ChatGPT.exe' -and $_.CommandLine -notmatch '--type=' } |
    Sort-Object ProcessId |
    Select-Object -First 1
  if ($null -eq $main) { $main = $Processes | Sort-Object ProcessId | Select-Object -First 1 }
  "${Version}:$($main.ProcessId)"
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

function Clear-StalePortFile {
  if (-not (Test-Path -LiteralPath $statePath)) { return }
  try {
    $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
    $port = [int]$state.port
    $response = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$port/json/version" -TimeoutSec 1
    if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 300) { return }
  }
  catch { }
  Remove-Item -LiteralPath $statePath -Force -ErrorAction SilentlyContinue
  Write-WatcherLog 'Removed a stale Codex Deck bridge port file.'
}

function Test-LauncherReady {
  if (-not (Test-Path -LiteralPath $launcherPath)) { return $false }
  if ($null -eq (Get-Command node -ErrorAction SilentlyContinue)) { return $false }
  $runtimeCandidates = @(
    (Join-Path $PSScriptRoot 'runtime-override.mjs'),
    (Join-Path $PSScriptRoot '..\release\codex-deck-launcher\runtime-override.mjs')
  )
  @($runtimeCandidates | Where-Object { Test-Path -LiteralPath $_ }).Count -gt 0
}

function Invoke-CodexDeckLauncher([switch]$ForceRestart) {
  if (-not (Test-LauncherReady)) {
    throw 'The Codex Deck launcher bundle or Node.js is unavailable; Codex was not restarted.'
  }
  $arguments = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $launcherPath)
  if ($ForceRestart) { $arguments += '-ForceRestart' }
  $output = & $powerShellPath @arguments 2>&1
  foreach ($line in $output) { Write-WatcherLog "Launcher: $line" }
  if ($LASTEXITCODE -ne 0) { throw "Codex Deck launcher failed with exit code $LASTEXITCODE." }
}

$createdNew = $false
$mutex = [Threading.Mutex]::new($true, $mutexName, [ref]$createdNew)
if (-not $createdNew) {
  Write-Host 'A Codex Deck watcher is already running.'
  $mutex.Dispose()
  exit 0
}

$sawStoppedSession = $false
$hadHealthyBridge = $false
$handledGeneration = ''
$lastHealthyGeneration = ''
$lastState = ''
$nextRecoveryAt = [DateTimeOffset]::MinValue
$readyPath = Join-Path $stateRoot 'watcher-ready.json'

try {
  if (-not (Test-LauncherReady)) { throw 'The watcher bundle is unavailable.' }
  $node = Get-Command node -ErrorAction Stop
  $major = [int]((& $node.Source --version).TrimStart('v').Split('.')[0])
  if ($major -lt 24) { throw 'Node.js 24 or newer is required; watcher startup was not confirmed.' }
  $runtime = Join-Path $PSScriptRoot 'runtime-override.mjs'
  if (-not (Test-Path -LiteralPath $runtime)) { $runtime = Join-Path $PSScriptRoot '..\release\codex-deck-launcher\runtime-override.mjs' }
  & $node.Source --input-type=module -e "await import('node:url').then(m => import(m.pathToFileURL(process.argv[2]).href))" codex-deck-preflight $runtime
  if ($LASTEXITCODE -ne 0) { throw 'The watcher runtime cannot load.' }
  [IO.File]::WriteAllText($readyPath, (@{ pid = $PID; token = $StartupToken } | ConvertTo-Json -Compress))
  Write-WatcherLog "Watcher started (pid=$PID, recoverExisting=$($RecoverExistingSession.IsPresent))."
  while ($true) {
    if (Test-Path -LiteralPath $stopPath) {
      Write-WatcherLog 'Watcher stop requested.'
      break
    }

    try {
      $codex = Get-CodexInstallation
      $processes = if ($null -eq $codex) { @() } else { Get-CodexProcesses $codex.Root }

      if ($processes.Count -eq 0) {
        if ($lastState -ne 'stopped') { Write-WatcherLog 'Codex is not running; waiting for its next launch.' }
        $lastState = 'stopped'
        $sawStoppedSession = $true
        $handledGeneration = ''
        Clear-StalePortFile
      }
      else {
        $generation = Get-CodexGeneration $codex.Version $processes
        $port = Get-HealthyDebugPort $processes

        if ($port) {
          $hadHealthyBridge = $true
          $sawStoppedSession = $false
          $handledGeneration = $generation
          if ($lastHealthyGeneration -ne $generation) {
            Write-WatcherLog "Healthy Codex Deck bridge detected for Codex $($codex.Version) on port $port."
            Invoke-CodexDeckLauncher
            $lastHealthyGeneration = $generation
          }
          $lastState = "healthy:$generation"
        }
        else {
          Clear-StalePortFile
          $mayRecover = Test-RecoveryAllowed $generation $handledGeneration $RecoverExistingSession $sawStoppedSession $hadHealthyBridge $nextRecoveryAt
          if ($generation -ne $handledGeneration -and $mayRecover) {
            $nextRecoveryAt = [DateTimeOffset]::UtcNow.AddMinutes(10)
            $handledGeneration = $generation
            Write-WatcherLog "Codex $($codex.Version) started without the bridge; performing one automatic recovery restart."
            Start-Sleep -Milliseconds 1500
            Invoke-CodexDeckLauncher -ForceRestart
            $hadHealthyBridge = $true
            $sawStoppedSession = $false
            $lastState = "recovered:$generation"
          }
          elseif ($lastState -ne "unmanaged:$generation") {
            Write-WatcherLog "Codex generation $generation is already running without the bridge. It will be recovered when the main process changes; the current session was left untouched."
            $lastState = "unmanaged:$generation"
            $handledGeneration = $generation
          }
        }
      }
    }
    catch {
      $message = $_.Exception.Message
      if ($lastState -ne "error:$message") { Write-WatcherLog "Watcher check failed: $message" }
      $lastState = "error:$message"
    }

    if ($Once) { break }
    Start-Sleep -Seconds $PollSeconds
  }
}
finally {
  Remove-Item -LiteralPath $readyPath -Force -ErrorAction SilentlyContinue
  $mutex.ReleaseMutex()
  $mutex.Dispose()
  Write-WatcherLog 'Watcher stopped.'
}
