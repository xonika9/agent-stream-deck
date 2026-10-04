# Security policy

## Supported versions

Until the first xonika9 release is published, security fixes target the current
`main` branch. After that, only the latest GitHub release is supported.

## Reporting

Report vulnerabilities through GitHub's private vulnerability reporting for
`xonika9/codex-stream-deck`:
<https://github.com/xonika9/codex-stream-deck/security/advisories/new>.
Do not publish a working exploit, authentication data, Codex databases, rollout
files, or local official SVG assets in a public issue.

## Important boundary

Codex Deck starts Codex with a Chrome DevTools endpoint bound to `127.0.0.1`. This is intentionally local but remains accessible to processes running as the same Windows or macOS user. Do not expose, forward, or rebind that port to a network interface.

The optional multi-host relay is a separate authenticated, typed protocol. Use only its loopback SSH tunnel or an explicit Tailscale address. Never forward CDP, use wildcard/public listeners, commit relay state, or share pairing tokens in commands, issues, logs, or screenshots.

OpenCode monitoring is opt-in. The characterized macOS integration accepts only a descriptor-checked local loopback service and saved SSH connections that authenticate non-interactively through the user's existing SSH configuration. An SSH service without a registration file may be discovered through bounded `opencode pair` and authenticated `opencode api` output inside the adapter; the adapter still requires an unauthenticated `401`/`403` boundary before sending the credential through its temporary loopback tunnel. A Stream Deck acknowledgement may send only the opaque session ID and exact terminal `idle` revision to that already-authenticated service's official session-view route; failure remains a local acknowledgement and never broadens transport authority. A bounded, sanitized task title may cross from the adapter only into the same-process local Stream Deck renderer; it must never enter logs, diagnostics, relays, or release artifacts. The integration must not expose endpoints or credentials, start a stopped service or WSL distribution, open OpenCode SQLite, read process/Chromium state, or project messages, locations, permission/form contents, costs, or token counts outside the adapter.

Release artifacts are audited for private runtime state, known personal setup markers, and protected Codex keycap SVG files. This reduces accidental packaging risk but does not replace review.
