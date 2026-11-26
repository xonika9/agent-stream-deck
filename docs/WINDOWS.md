# Windows-only setup

This mode runs Stream Deck and Codex on the same Windows PC. It needs no relay, SSH, Tailscale, Mac, or host-target key.

## Install

1. Install `com.xonika9.codex-deck.streamDeckPlugin` by opening it.
2. Extract `agent-deck-launcher-windows-vX.Y.Z.zip` to a normal folder.
3. Install Node.js 24 or newer if `node --version` is unavailable.
4. Inspect the current state without changing Codex:

   ```powershell
   .\Start-AgentDeck.ps1 -DryRun
   ```

5. Double-click **Start Agent Deck.cmd**. A bridge-enabled Codex session is reused. If Codex is already running normally without the bridge, the launcher explains that one restart is required before doing it.
6. Open **Codex Settings > Codex Micro**, configure the native slots, and add the actions from the [recommended layout](../README.md#recommended-15-key-layout).

## Keep the bridge available

Run once from the extracted launcher folder:

```powershell
.\Start-AgentDeck.ps1 -InstallStartup
```

This installs a durable private launcher copy under `%LOCALAPPDATA%\AgentDeck\launcher` and creates one hidden sign-in watcher. The extracted ZIP can then be moved or deleted. The watcher dynamically follows Codex Store updates, prevents duplicate instances, removes stale port state.

Installing the watcher does **not** restart a normal Codex session that is already open. That generation remains untouched. After the next normal Codex close/reopen or an app update, the watcher may perform one recovery restart if the new generation launched without the bridge.

To update the watcher, extract a newer Windows launcher and run `-InstallStartup` again. User icons, old private relay settings, host identity, and other state are not overwritten. The new watcher does not create relay tunnels, and the plugin ignores old remote selections. The existing host key keeps its UUID and shows local connection status. Building the repository does not replace a previously installed watcher; reinstall the matching launcher to update its copied runtime.

The installer checks the bundle and Node.js 24 before stopping the existing watcher, then waits for the new watcher to confirm startup. Failure after stopping is reported as a partial update and does not resume the retired relay.

### Upgrading from a Codex Deck launcher

Older launchers kept their data and durable watcher in `%LOCALAPPDATA%\CodexDeck` and started it from a **Codex Deck** startup shortcut. Update the Stream Deck plugin first, then run `-InstallStartup` from the new launcher. It stops the old watcher, moves `%LOCALAPPDATA%\CodexDeck` to `%LOCALAPPDATA%\AgentDeck` in one directory move (files keep their permissions; the old folder no longer exists), replaces the old shortcut with **Agent Deck**, and removes the retired `Start-CodexDeck.ps1` and `Watch-CodexDeck.ps1` copies.

If the move fails, for example because another program has a file in that folder open, nothing is moved: close that program and run `-InstallStartup` again. If both folders already exist, nothing is merged: Agent Deck uses `AgentDeck`, leaves `CodexDeck` untouched, and prints a warning. Until `-InstallStartup` has run, the plugin and `Start Agent Deck.cmd` keep using `CodexDeck`. A running plugin follows the move on its next read; it needs no restart.

## Useful commands

```powershell
.\Start-AgentDeck.ps1 -DryRun          # read-only diagnosis
.\Start-AgentDeck.ps1                 # start or reuse the bridge
.\Start-AgentDeck.ps1 -InstallStartup # install/update persistent watcher
.\Start-AgentDeck.ps1 -UninstallStartup
```

`-ForceRestart` exists for an explicit clean restart, but is not a normal update or troubleshooting step.

## Files

```text
%LOCALAPPDATA%\AgentDeck\
  launcher\                    # durable watcher runtime
  codex-micro-bridge.json      # current local loopback port
  host.json                    # stable local host identity
  watcher.log                  # bounded diagnostics
  icons\                       # optional user-owned SVG copies
```

The launcher does not patch the installed Codex package.

## Uninstall

1. Run `Start-AgentDeck.ps1 -UninstallStartup` before deleting the launcher.
2. Remove Agent Deck in Stream Deck's plugin settings.
3. Delete `%LOCALAPPDATA%\AgentDeck` only if you also want to remove local icons, identity, relay configuration, and diagnostics.

Uninstalling the watcher does not close or restart Codex.

Automatic recovery reserves a global ten-minute cooldown before each restart; process replacement and failed attempts do not reset it. Updating waits up to 30 seconds for the owned watcher mutex; timeout retains the stop marker and leaves bundle files untouched. The runtime and its packaged dependencies are safely imported from a staged autonomous copy before stopping. Readiness confirms the new live process and startup token.

An old `relay-tunnel.pid` is used only with its saved `relay-client.json` and exact documented SSH command to prove ownership. Proven old Codex relay tunnels are stopped; unknown SSH or OpenCode processes remain untouched and the update reports an incomplete migration. Private JSON settings remain on disk. Only the retired `Configure-CodexDeckRelay.ps1`, `Configure-CodexDeckMobile.ps1`, `mobile-pairing.mjs`, `Start-CodexDeck.ps1`, and `Watch-CodexDeck.ps1` bundle files are removed.

## Renderer module discovery

Some Codex builds omit dynamically imported Micro chunks from resource timing and preload links. The bridge falls back to a bounded, same-host dependency walk of core renderer modules, caches successful discovery for the document lifetime, and retries failed discovery. Launcher readiness now requires a successful six-slot snapshot, not only device activation. No installed Codex files are changed.
