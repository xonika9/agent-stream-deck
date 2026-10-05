# Security policy

## Supported versions

Until the first xonika9 release is published, security fixes target the current
`main` branch. After that, only the latest GitHub release is supported.

## Reporting

Report vulnerabilities through GitHub's private vulnerability reporting for
`xonika9/agent-stream-deck`:
<https://github.com/xonika9/agent-stream-deck/security/advisories/new>.
Do not publish a working exploit, authentication data, Codex databases, rollout
files, or local official SVG assets in a public issue.

## Important boundary

Codex Deck starts Codex with a Chrome DevTools endpoint bound to `127.0.0.1`. This is intentionally local but remains accessible to processes running as the same Windows or macOS user. Do not expose, forward, or rebind that port to a network interface.

The separate Codex relay, remote target selection, and relay tunnel launch paths have been removed. Old private connection files and tokens are ignored rather than deleted; they must still never be committed, logged, or packaged. Existing host action UUIDs remain local. The independent OpenCode SSH authority below is unchanged.

OpenCode monitoring is opt-in. The characterized macOS integration accepts only a descriptor-checked local loopback service and saved SSH connections that authenticate non-interactively through the user's existing SSH configuration. An SSH service without a registration file may be discovered through bounded `opencode pair` and authenticated `opencode api` output inside the adapter; the adapter still requires an unauthenticated `401`/`403` boundary before sending the credential through its temporary loopback tunnel. A Stream Deck acknowledgement may send only the opaque session ID and exact terminal `idle` revision to that already-authenticated service's official session-view route; failure remains a local acknowledgement and never broadens transport authority. A bounded, sanitized task title may cross from the adapter only into the same-process local Stream Deck renderer; it must never enter logs, diagnostics, relays, or release artifacts. The integration must not expose endpoints or credentials, start a stopped service or WSL distribution, open OpenCode SQLite, read process/Chromium state, or project messages, locations, permission/form contents, costs, or token counts outside the adapter.

Release artifacts are audited for private runtime state, known personal setup markers, and protected Codex keycap SVG files. This reduces accidental packaging risk but does not replace review.

Launcher updates preflight the autonomous runtime and Node.js 24 before stopping the owned watcher. Windows legacy SSH cleanup requires the saved PID, exact saved loopback forwarding target and documented arguments; an unproven tunnel stops migration with an actionable error. Private configuration is preserved; OpenCode and unrelated tunnels are never adopted by port.

## T3 Code source

The macOS adapter uses a separately paired `orchestration:read` bearer session,
stored in a current-user-owned regular file with mode `0600`. It rejects symlinks
and group/other-readable configuration. The saved origin must be loopback HTTP
and match T3 runtime registration with a live process. Redirects are rejected,
requests are bounded, and credentials are never logged or put in Stream Deck
global settings. No T3 command dispatch, database access, desktop credential
decryption, or public network HTTP access is added. See `docs/T3CODE_COMPATIBILITY.md`.

T3 remote monitoring accepts explicitly configured SSH aliases only. It uses
non-interactive SSH with strict existing host-key checking and disables local
commands and forwarding. A setup command pairs a separate read-only session using
the already-running Linux server executable; polling checks its registered runtime
and saved environment identity and performs loopback HTTP inside that SSH host.
Tokens pass through stdin, never argv or logs. Responses are bounded and each
failed environment loses its stale cards without erasing successful snapshots.
No remote service, relay or tunnel is started.
