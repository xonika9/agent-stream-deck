# Windows-only setup

This mode runs Stream Deck and Codex on the same Windows PC. It needs no relay, SSH, Tailscale, Mac, or host-target key.

## Install

1. Install `com.xonika9.codex-deck.streamDeckPlugin` by opening it.
2. Extract `codex-deck-launcher-windows-vX.Y.Z.zip` to a normal folder.
3. Install Node.js 20 or newer if `node --version` is unavailable.
4. Inspect the current state without changing Codex:

   ```powershell
   .\Start-CodexDeck.ps1 -DryRun
   ```

5. Double-click **Start Codex Deck.cmd**. A bridge-enabled Codex session is reused. If Codex is already running normally without the bridge, the launcher explains that one restart is required before doing it.
6. Open **Codex Settings > Codex Micro**, configure the native slots, and add the actions from the [recommended layout](../README.md#recommended-15-key-layout).

## Keep the bridge available

Run once from the extracted launcher folder:

```powershell
.\Start-CodexDeck.ps1 -InstallStartup
```

This installs a durable private launcher copy under `%LOCALAPPDATA%\CodexDeck\launcher` and creates one hidden sign-in watcher. The extracted ZIP can then be moved or deleted. The watcher dynamically follows Codex Store updates, prevents duplicate instances, removes stale port state, and keeps an optional SSH relay tunnel alive.

Installing the watcher does **not** restart a normal Codex session that is already open. That generation remains untouched. After the next normal Codex close/reopen or an app update, the watcher may perform one recovery restart if the new generation launched without the bridge.

To update the watcher, extract a newer Windows launcher and run `-InstallStartup` again. User icons, relay settings, host identity, and other state are not overwritten.

## Useful commands

```powershell
.\Start-CodexDeck.ps1 -DryRun          # read-only diagnosis
.\Start-CodexDeck.ps1                 # start or reuse the bridge
.\Start-CodexDeck.ps1 -InstallStartup # install/update persistent watcher
.\Start-CodexDeck.ps1 -UninstallStartup
```

`-ForceRestart` exists for an explicit clean restart, but is not a normal update or troubleshooting step.

## Files

```text
%LOCALAPPDATA%\CodexDeck\
  launcher\                    # durable watcher runtime
  codex-micro-bridge.json      # current local loopback port
  host.json                    # stable local host identity
  watcher.log                  # bounded diagnostics
  icons\                       # optional user-owned SVG copies
```

The launcher does not patch the installed Codex package.

## Uninstall

1. Run `Start-CodexDeck.ps1 -UninstallStartup` before deleting the launcher.
2. Remove Codex Deck in Stream Deck's plugin settings.
3. Delete `%LOCALAPPDATA%\CodexDeck` only if you also want to remove local icons, identity, relay configuration, and diagnostics.

Uninstalling the watcher does not close or restart Codex.
