CODEX DECK LAUNCHER

1. Install Node.js 24 or newer.
2. Double-click "Start Codex Deck.cmd" instead of launching Codex normally.
3. Keep that Codex session open while using the Stream Deck plugin.

If Codex is already running from this launcher, running it again reuses the
existing debug session instead of closing and reopening Codex. Use
`Start-CodexDeck.ps1 -ForceRestart` only when you explicitly want a clean
restart.

If Codex was started normally without a debug port, the launcher must restart
that session once. It then starts the installed Codex Windows app with a
loopback-only Chrome DevTools port and enables the Codex Micro UI for that
session. It does not patch the Codex installation or upload any data.

Recommended: run `Start-CodexDeck.ps1 -InstallStartup` once. This installs a
durable private launcher copy under `%LOCALAPPDATA%\CodexDeck\launcher` plus a
single hidden background watcher that stays active after Windows sign-in. It
detects Codex restarts and app updates, removes stale bridge data, and restores
the bridge automatically whenever Codex starts again.

Installing the watcher never restarts an already-open normal Codex session.
That session is recovered after you next close and reopen Codex. At later
Windows logins or after Codex updates, the watcher may perform one immediate
recovery restart when Codex launches without its required loopback port.

Remove the watcher with `Start-CodexDeck.ps1 -UninstallStartup`. Diagnostics
are written to `%LOCALAPPDATA%\CodexDeck\watcher.log`.

Optional Mac pairing: after configuring the relay on the Mac, run
`Configure-CodexDeckRelay.ps1 -MacAddress 127.0.0.1 -SshHost <Mac SSH alias>`.
Paste the token into the hidden prompt instead of placing it on the command
line. The watcher keeps this dedicated SSH relay tunnel alive and
does not reuse Codex desktop's remote-CLI SSH process. Restart the Stream Deck
plugin, not Codex. Remove the relay with `-Disable`.

This is an unofficial compatibility bridge and may need an update after a Codex
desktop release.
