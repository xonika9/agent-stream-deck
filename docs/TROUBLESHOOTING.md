# Troubleshooting

## Stream Deck is blank or page changes take several seconds

Check the USB connection before changing the plugin. A flaky hub, port, cable,
or connection can leave old page images on the device and can also prevent the
keys from lighting up at all.

1. Disconnect and reconnect the Stream Deck.
2. Try another port on the Mac.
3. As a diagnostic check, connect the Stream Deck directly to the Mac once.
4. After the device lights normally, repeat the same page switch with the
   plugin enabled and disabled.

A hub is not automatically unsupported for development: keep using it when the
device starts reliably and page changes are immediate. USB-C Power Delivery
charging the Mac through the hub does not by itself prove that the hub's
downstream USB data and peripheral power path is stable. If the delay also
reproduces over a direct connection, continue with plugin diagnostics.

## Codex Micro is missing from Settings on Windows

- You can safely run the launcher again while a launcher-started Codex session is open; it now reuses the existing debug session instead of restarting Codex.
- Use `Start-CodexDeck.ps1 -ForceRestart` only when you explicitly want to restart Codex.
- To keep it available across Windows sign-in, Codex restarts, and Codex app updates, run `Start-CodexDeck.ps1 -InstallStartup` once. This installs a persistent single-instance watcher. Remove it with `-UninstallStartup`.
- Installing monitoring leaves an already-open normal Codex session untouched. Close and reopen Codex once, or run the launcher manually when you are ready for that one recovery restart.
- Watcher diagnostics are stored in `%LOCALAPPDATA%\CodexDeck\watcher.log` and rotate automatically.
- Close all Codex windows.
- Start Codex with `Start Codex Deck.cmd`.
- After `-InstallStartup`, the watcher uses its durable copy under `%LOCALAPPDATA%\CodexDeck\launcher`; the extracted ZIP is no longer required.
- Run this diagnostic from the launcher folder:

```powershell
.\Start-CodexDeck.ps1 -DryRun
```

If the launcher times out after a Codex update, open an issue with the exact Codex version and launcher output.

## Codex Micro is missing from Settings on macOS

Run these from the extracted matching launcher:

```zsh
./start-codex-deck.sh dry-run
./start-codex-deck.sh self-test
tail -n 100 "$HOME/Library/Application Support/CodexDeck/watcher.log"
```

Do not replace, re-sign, or edit the Codex app bundle. If `start` says an existing normal session needs a restart, it waits for your explicit `yes`.

The installed watcher never launches Codex while it is closed. After you open Codex manually, one controlled recovery restart can occur if the new process lacks the loopback bridge. A global cooldown prevents further automatic restarts across replacement PIDs.

If an older watcher is repeatedly relaunching Codex after a crash or empty battery, stop only that watcher first:

```zsh
launchctl bootout "gui/$(id -u)/com.simeo.codex-deck.watcher"
```

Then install the launcher from the newest release. This command does not start, stop, or modify Codex itself.

## Agent keys say Bridge offline

- Confirm Codex was started through the launcher.
- Confirm the platform bridge state exists and contains a port number:
  - Windows: `%LOCALAPPDATA%\CodexDeck\codex-micro-bridge.json`
  - macOS: `~/Library/Application Support/CodexDeck/codex-micro-bridge.json`
- Restart Stream Deck.
- Do not run two launcher-started Codex instances at the same time.

## A key flashes an alert

The native handler was unavailable or the action is not valid in the current composer state. Check that the relevant function is assigned in **Codex Settings > Codex Micro** and that the intended Codex window/composer is active.

## Agent assignments are unexpected

Codex Deck does not choose the six native tasks. Open **Codex Settings > Codex Micro > Agent keys** and select pinned, recently updated, priority, or custom assignments.

If **Active queue** is enabled, the plugin uses Codex's complete native pinned + unpinned sidebar catalog when available. It hides idle/off tasks, compacts the rest to at most six display positions, and can open an exact task outside the current six Micro slots through the native event handler. If optional catalog discovery fails, that host falls back to its six Micro slots. `custom` stays limited to its configured six candidates, which the queue may still compact. Disable the queue to inspect or use the exact native local positions again.

## Active queue is black or misses a working task

- Confirm the task appears in Codex's native sidebar. Active queue discovers pinned and unpinned sidebar tasks but never reads task content or a task database.
- A renderer compatibility change can temporarily disable optional catalog discovery. In that case the queue safely falls back to the six native Micro slots; ordinary mode remains unchanged.
- An all-black Agent row can be healthy when the catalog contains no relevant non-idle tasks. Black empty positions are no-op, not a bridge failure.
- Make sure the profile contains logical **Agent 1** through **Agent N** contiguously and in order. Queue positions close up from Agent 1.
- Idle chats are intentionally unavailable while Active queue is enabled. Turn it off when you need their original assignments.
- `CONNECT`, `DEGRADED`, or `OFFLINE` tiles are diagnostics and remain visible instead of becoming black. Follow the local bridge checks in this guide for those states.

## Working Agent keys changed order unexpectedly

- A new structural user message legitimately moves a continuously working task forward. Merely opening or selecting a task, changing its title, background reasoning or tool work, assistant output, renderer activity, and refreshes do not.
- A queue epoch is process-local. Disabling and re-enabling **Active queue**, or restarting the plugin, starts a new epoch and may reseed tasks whose start event is unknown.
- Starts can be unknown with an older sender, after a cold start, or when the event is outside the bounded 512 KiB session tail. First seeing a task already working gives it a stable fallback position; it is not treated as newly started. Known starts rank ahead of unknown starts, and an observed idle/completion-to-working transition may move an unknown task within its tier.
- Temporarily disappeared tasks retain their queue-local rank for 24 hours. A longer absence is treated as a fresh unknown observation.
- Ordering inspects only the structural event type, timestamp, and byte offset. It does not read the user-message text or send that text.

## Local command icon does not appear

- Verify the file is in `%LOCALAPPDATA%\CodexDeck\icons` on Windows or `~/Library/Application Support/CodexDeck/icons` on macOS.
- Verify the filename exactly matches the keycap ID reported by Codex, including `+` or `-`.
- Verify the SVG has a numeric `viewBox`.
- Restart Stream Deck after changing icon files.

## Plugin does not appear after installation

Restart Stream Deck. Elgato notes that plugins can fail to appear when the Stream Deck app is still running with elevated state after an install or update.

## Local connection key says DEGRADED

The existing `host-toggle` key now shows the local Codex connection only. Pressing it redraws its status and does not change the target. `DEGRADED` means that the local native Micro state cannot currently be confirmed, for example during startup or after a renderer compatibility change. Wait briefly, then inspect the local watcher logs. Last-known agent colors are uncertain until the connection returns to `READY`.

Old remote selections and pairing files are ignored without deleting their private contents. An old copied watcher can still run until it is replaced: install the matching new platform launcher to update it. Saved OpenCode SSH connections are independent and remain supported.

## What to include in a bug report

- Codex app version and platform (`Get-AppxPackage OpenAI.Codex | Select-Object Version` on Windows; bundle version on macOS).
- Stream Deck version and device model.
- Windows version.
- Whether `Start-CodexDeck.ps1 -DryRun` succeeds.
- The relevant Stream Deck plugin log excerpt.
- The exact action that failed.

Do not attach Codex databases, rollout files, relay JSON, authentication data, personal paths, or official SVG asset files.

If an update reports incomplete legacy relay ownership, inspect the saved PID and its original command before manually terminating anything; a matching forwarded port does not prove ownership. If shutdown times out, no bundle files were replaced and `watcher.stop` remains. A partial update after shutdown requires correcting the bundle/runtime and rerunning the installer; it does not restore retired listeners. Windows automatic recovery waits ten minutes between attempts, even across changed process IDs or failure.
