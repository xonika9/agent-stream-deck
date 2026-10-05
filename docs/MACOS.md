# macOS-only setup

This mode runs Stream Deck and Codex on the same Mac. It needs no Windows PC, relay, SSH, Tailscale, or host-target key. The same plugin package used on Windows launches new tasks and agent links locally through macOS.

## Install

1. Install `com.xonika9.codex-deck.streamDeckPlugin` in Stream Deck for macOS.
2. Extract `codex-deck-launcher-macos-vX.Y.Z.zip`. The official release ZIP is created on macOS so its executable bits are preserved.
3. Install Node.js 24 or newer if `node --version` is unavailable.
4. From Terminal in the extracted launcher directory, run:

   ```zsh
   ./start-codex-deck.sh dry-run
   ./start-codex-deck.sh self-test
   ./start-codex-deck.sh start
   ```

   **Start Codex Deck.command** is the double-clickable equivalent of `start`.
5. Open **Codex Settings > Codex Micro**, configure the native slots, and add the actions from the [recommended layout](../README.md#recommended-15-key-layout). The existing host key shows the local connection status.

If an archive tool removed executable permissions, restore only the two launcher files:

```zsh
chmod +x start-codex-deck.sh "Start Codex Deck.command"
```

## Keep the bridge available

```zsh
./start-codex-deck.sh install
```

`install` copies the watcher runtime into Application Support and installs a per-user LaunchAgent. It does not restart a normal Codex session already open during first installation and never launches Codex while the app is closed. After you open Codex normally, a later unbridged process must remain stable before it may receive one graceful recovery restart. A global cooldown blocks further automatic recovery across replacement process IDs, preventing restart loops after crashes, power loss, or incomplete app startup.

Update by extracting the new launcher and running `install` again. The stable host identity, old private relay configuration, and user-owned icons are preserved.

The installer checks the bundle and Node.js 24 before stopping the existing watcher, then waits for the new watcher to confirm startup. Failure after stopping is reported as a partial update and does not resume the retired relay.

## Commands

```zsh
./start-codex-deck.sh dry-run
./start-codex-deck.sh self-test
./start-codex-deck.sh start
./start-codex-deck.sh install
./start-codex-deck.sh uninstall
```

`start` asks for an explicit `yes` before restarting an already-running normal Codex session. Codex launches through LaunchServices so Input Monitoring/TCC permissions remain attached to the signed app bundle.

## Files

```text
~/Library/Application Support/CodexDeck/
  codex-deck-macos.mjs
  watcher-launch.sh
  codex-micro-bridge.json
  host.json
  watcher-state.json
  watcher.log, watcher.log.1 ...
  watcher.stderr.log             # LaunchAgent/runtime failures
  icons/                         # optional user-owned SVG copies

~/Library/LaunchAgents/com.simeo.codex-deck.watcher.plist
```

State writes are atomic, a PID-directory lock prevents duplicate watchers, and logs rotate at approximately 1 MB with three retained generations. Nothing inside the Codex app bundle is modified or re-signed.

## Diagnostics

```zsh
./start-codex-deck.sh dry-run
tail -n 100 "$HOME/Library/Application Support/CodexDeck/watcher.log"
tail -n 100 "$HOME/Library/Application Support/CodexDeck/watcher.stderr.log"
launchctl print "gui/$(id -u)/com.simeo.codex-deck.watcher"
plutil -lint "$HOME/Library/LaunchAgents/com.simeo.codex-deck.watcher.plist"
```

## Existing profiles and remote settings

The `host-toggle` action keeps its UUID and shows the local connection state. Pressing it redraws the status; it does not select another computer. Old Codex relay settings and tokens are ignored and their private files are preserved. Saved OpenCode SSH connections, including Fedora, remain available through the **OpenCode** and **All** sources.

The watcher runtime is copied outside the repository. Rebuild and run `install` from the new launcher to replace the old watcher; building alone does not stop an installed legacy listener. Keep the established `com.simeo.codex-deck.watcher` service label.

## Uninstall

```zsh
./start-codex-deck.sh uninstall
```

This unloads the LaunchAgent and removes its runtime, bridge state, policy state, lock, and logs. It deliberately preserves `host.json`, old private relay configuration, and `icons/`. No Codex application data is removed and Codex is not restarted.

The installer runs the copied autonomous runtime self-test with the same Node.js 24 resolver before stopping the owned service. A failed stop while the service remains registered preserves its runtime. Success requires the service PID, lock PID and fresh startup token to agree; bootstrap/readiness failure is a partial update and does not restore removed listeners.
