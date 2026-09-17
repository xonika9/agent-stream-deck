# Architecture and security

## Components

### Launcher

`Start-CodexDeck.ps1` finds the installed Microsoft Store Codex package. If a healthy debug-enabled Codex process already exists, it reuses its loopback port. Starting an already-running normal session requires an explicit launcher/recovery path; a read-only `-DryRun` never changes it. The launcher chooses an unused loopback port, writes it to `%LOCALAPPDATA%\CodexDeck\codex-micro-bridge.json`, and starts `ChatGPT.exe` with:

```text
--remote-debugging-address=127.0.0.1
--remote-debugging-port=<random-port>
```

The bundled runtime helper connects to that renderer and enables the Micro feature state for the current session. It discovers the versioned `persisted-signal-*` asset dynamically; no asset hash is hardcoded.

The launcher does not edit the Codex installation, Codex LevelDB, task database, rollout files, or logs.

When startup monitoring is installed, a durable copy under `%LOCALAPPDATA%\CodexDeck\launcher` runs `Watch-CodexDeck.ps1` as
a single hidden PowerShell process. It dynamically resolves the newest Codex
Microsoft Store package on every check, so an app update can change the install
path without invalidating the watcher. A named mutex prevents duplicates.

The watcher follows three safety rules:

1. A healthy debug-enabled Codex session is reused and never restarted.
2. A normal session that was already open when monitoring was installed is left untouched until its next normal restart.
3. A later Codex launch, update restart, or crash recovery without the required loopback port receives at most one recovery restart for that process generation.

Stale port metadata is removed automatically. The bounded watcher log lives at
`%LOCALAPPDATA%\CodexDeck\watcher.log`.

On macOS, the launcher discovers the running or installed app by its signed
bundle metadata, reads `CFBundleExecutable`, and launches the app bundle through
LaunchServices with the same loopback-only debugging arguments. The per-user
LaunchAgent watcher stores a main-process generation (PID, start time, and
executable path), reuses healthy bridges, and performs at most one graceful
recovery restart for a later stable unbridged generation. It never launches a
closed Codex app. A generation-independent cooldown prevents a failed recovery
from becoming a PID-to-PID restart loop, even if LaunchServices immediately
creates another process. The generation and recovery policy is persisted
atomically and guarded by a PID-directory lock. LaunchAgent stderr is retained
separately from the bounded watcher log for post-crash diagnosis.

Both platforms persist a stable `hostId`, `hostName`, and platform identifier.
The relay uses that identity; the CDP port is never a relay endpoint.

### Stream Deck plugin

The same plugin runs on Windows and macOS. It discovers the local loopback port from the platform state file or from a running Codex process. It then uses Chrome DevTools Protocol `Runtime.evaluate` calls to:

1. discover the current version-hashed Codex renderer modules;
2. announce a connected Micro device state;
3. read the mandatory native six-slot state, layout, agent source, and lighting preference, then optionally discover the bounded native pinned + unpinned sidebar catalog;
4. dispatch Micro HID and joystick events;
5. emulate native encoder-rotation HID events for reasoning-effort changes;
6. resolve standalone keycap actions from Codex's live Micro keycap registry and current official command runner;
7. read Codex's renderer-owned `rate-limit-status` query and normalize its current 5-hour, weekly, and reset-credit state.

The bridge does not emulate a USB HID device and installs no driver.

For the characterized macOS OpenCode setup, the plugin starts a separate
collector only when the global Agent source is `OpenCode` or `Both`. It discovers
the managed local service from its user-owned loopback registration and saved SSH
connections from `opencode.settings`. SSH uses non-interactive authentication and
a temporary loopback forward. The adapter publishes only opaque identities,
content-free labels, normalized state, and bounded timestamps. It does not open
OpenCode SQLite, invoke WSL, launch a stopped service, or expose connection and
task content.

### Active queue projection

`Active queue` is a plugin display option shared by all six Agent actions on one
computer. An absent or false setting leaves the current native single-host or
combined multi-host agent-source result unchanged. When enabled outside
`custom`, the controller pools each host's authoritative native pinned +
unpinned sidebar catalog, resolves trusted conversation mirrors and ownership,
and only then projects at most six display positions. An absent catalog falls
back per host to its six Micro slots; an authoritative empty catalog remains
empty. `custom` keeps its six configured candidates instead of expanding to the
full catalog; the projection may still compact relevant candidates within that set.

The global task-source selector runs before this projection. `Codex` preserves
the saved Active queue preference; `OpenCode` and `Both` force the projection
without overwriting that preference. OpenCode candidates use the same
attention/completion/working groups but keep case-sensitive opaque identities
and never receive a context ring. An OpenCode key-down only foregrounds OpenCode
Desktop; key-up is intentionally a no-op.

The projection drops `idle`, `off`, and unknown states, then compacts candidates
into display positions zero through five. Attention and error states sort first;
completion and unread states use oldest available activity first; working states
use the latest trustworthy user-start event. Session ownership recognizes only a
structural JSONL record with `type === "event_msg"` and
`payload.type === "user_message"`, and reads only its type, timestamp, and byte
offset. The message field is not read. Its timestamp becomes `workStartedAt` and
its byte offset becomes the monotonic `workStartRevision`; background reasoning,
tool and assistant output, title or selection changes, renderer activity, and
snapshot refreshes remain general activity and do not change working rank.

The long-lived controller owns an in-memory queue epoch. A trustworthy start is
ranked once after clock normalization; repeated or lower revisions remain fixed,
while a higher revision from the task's current exact owner moves it to the front
of the working group. A task without a trustworthy start receives a stable
queue-local fallback. First observing an already-working task only seeds that
fallback and never fabricates a start time; a later observed idle/completion to
working transition may raise it within the unknown-start tier. Known starts sort
ahead of unknown starts. Disappeared identities remain for 24 hours, while
disabling and re-enabling Active queue or restarting the process clears the epoch.
Display positions may therefore change only for these defined transitions, but
commands keep the exact host-local thread key, native transport-slot hint, and
owning host. Pinned and unpinned tasks share the full catalog in this view.

A missing projected task renders as a black no-op key while the relevant host is
healthy. Connecting, degraded, and offline states continue through the normal
diagnostic rendering path. Completion freshness remains bounded by the existing
upstream structural-event window and acknowledgement behavior: the projection
adds no task database, durable queue, or restart persistence.

Relay protocol version 1 is extended additively with the optional atomic
`workStartedAt` / `workStartRevision` pair; the version is not bumped. Old senders
omit it. Receivers reject malformed or partial pairs and normalize the timestamp
to the receiver clock. Only the exact rollout owner can contribute the pair during
mirror merge, so renderer-mirror activity cannot reorder a task. This display-only
projection does not change owner routing, the loopback-only CDP endpoint,
independent Windows-only or macOS-only operation, optional multi-host operation,
or the privacy boundaries below.

Usage data remains account-scoped and therefore does not follow the Mac/Windows function-key target. On macOS, quota windows come from the newest valid CodexBar `widget-snapshot.json` Codex entry and expire after five minutes; this path does not start or attach Codex Desktop and does not fall back to renderer quota from another host. Reset-credit counters may still be overlaid from an already-attached local Codex bridge. Windows retains the renderer-owned usage query and its existing fallback behavior. Window identity is derived from duration rather than primary/secondary ordering. A missing 5-hour window is unavailable, and Automatic mode falls back to weekly.

Reset consumption is the only mutating usage operation. It is a narrow typed relay command and calls Codex's current native reset-credit client only after the Stream Deck key has been held for 1.2 seconds. The bridge verifies both availability and applicability, selects an available plan-supported credit, uses a unique redemption request ID, and then refreshes the renderer query. No credential, raw endpoint access, or arbitrary request surface is exposed to the relay.

### Optional multi-host relay

The Mac watcher can host an authenticated WebSocket relay on loopback behind an
SSH tunnel or on one explicitly configured Tailscale address. Wildcard listeners are rejected. The Windows
Stream Deck plugin connects as a client, merges typed Mac and Windows snapshots,
and routes agent presses by stable `(hostId, threadKey)` identity. Other controls
target the host selected by the Windows/Mac toggle.

Host ownership is resolved from exact local rollout filenames, not from a
renderer's mirrored recent list. This distinguishes a task's owning desktop
from a stale cloud or remote-SSH mirror. A bounded rollout tail is searched only
for structural activity/completion event tags and the latest numeric
`token_count` record. The latter provides optional context-window percentage
metadata for the small agent-key ring. Prompts, responses, project names, and
other content are neither parsed nor relayed. The relay never reads or proxies
the remote CLI app-server stream.

The relay protocol has no arbitrary-evaluation, filesystem, shell, or raw-CDP
operation. Payloads are capped at 64 KiB, authentication is required before a
snapshot or command is accepted, and command results use request IDs with
bounded timeouts.

### Optional iPhone transports

The iPhone consumes the same authenticated protocol through two independent
transport profiles. Remote mode keeps the relay on loopback and uses private
Tailscale Serve TLS. Nearby mode binds only the typed relay to one discovered
RFC 1918 address; Chrome DevTools remains on `127.0.0.1`. Nearby creates a
per-host P-256 certificate and random token, pins the certificate fingerprint
in the iPhone profile, and stores the token in Keychain.

Bonjour `_codexdeck._tcp` announces protocol version, stable `hostId`, display
name, platform, private address, relay port, and certificate fingerprint. It
never announces the token. The QR deep link carries the initial private
endpoint, token, and fingerprint. Later Bonjour address changes are accepted
only for the already-paired `hostId` with the same pinned fingerprint. Config
and QR files are written atomically with user-only permissions and are excluded
by the release-state audit.

The nearby and Tailscale listeners are separate, so enabling local discovery
does not replace or weaken remote access. No public relay is bundled: a
reliable internet alternative would require operated identity, TURN/push, rate
limiting, and abuse controls rather than exposing a desktop listener.

An authenticated client may remain connected while the Mac app or its native
Micro signals are unavailable. Snapshot failures are caught and rate-limited;
they do not terminate the relay server or watcher. Normal snapshots resume
automatically when the local bridge becomes ready.

The relay emits an authenticated, typed `degraded` health event when its native
snapshot source fails. The client also treats a snapshot as stale from its own
receipt time, so clock differences between computers cannot hide a failure.
Transport loss is a separate `offline` state. The controller preserves the
last-known host snapshot to keep the six-key layout stable, overlays the health
state on affected agent tiles, and uses the Windows/Mac target key as the
host-wide health surface. Preserved data is display-only: command dispatch still
requires a live authenticated connection.

### Rendering

Agent keys are original deterministic SVGs generated in memory from task title and state. The status palette is:

| Native state | Display |
|---|---|
| `off` | dark / unassigned |
| `idle` | white |
| `working` | saturated blue animation |
| `unread` | green completion |
| `approval` | orange pause/input |
| `error` | red error |

When Codex exposes token usage for a task, an optional top-right ring shows the
latest context-window percentage. Orange begins at 80% and red at 92%. Select
any Agent key in Stream Deck's property inspector to show or hide this ring
globally for all six agent keys on that computer. The setting is independent on
Windows and macOS and does not stop context metadata from syncing.

The upper-left position is reserved for the task-state mark. If host health is
not ready, the host-health mark replaces it so the two signals do not overlap.

The renderer derives the active Codex appearance from explicit theme tokens when available and falls back to the computed renderer surface luminance. Dark mode uses layered charcoal surfaces rather than pure black, with off-white text and slightly lifted status colors for the Stream Deck display.

Official Codex Micro keycap SVG contents are not part of the source or release. Optional user-local files are loaded from `%LOCALAPPDATA%\CodexDeck\icons` on Windows or `~/Library/Application Support/CodexDeck/icons` on macOS and wrapped in the project's neutral key surface at runtime.

The controller uses non-overlapping self-scheduled refreshes and caches the last
image sent to each action instance. Unchanged keys therefore produce no repeated
USB image writes. Animated frames are limited to working and approval states.

## Trust boundary

CDP provides privileged access to the Codex renderer. Binding to `127.0.0.1` prevents direct access from another machine, but not from another process running as the same local user. Treat the launcher-started session like any other local debugging session:

- do not run untrusted software at the same time;
- do not change the debug address to `0.0.0.0`;
- do not forward the port;
- close Codex when the bridge is no longer needed.

## Data flow

In desktop-only single-host mode Codex Deck has no server, API key, analytics
endpoint, or update service. Runtime data stays between Stream Deck, the local
plugin process, the local Codex renderer, and explicitly selected local OpenCode
transports. OpenCode endpoints, SSH targets, credentials, task titles, messages,
locations, and permission/form content remain inside the adapter and are not
logged or rendered. Optional iPhone Nearby pairing
adds only the authenticated pinned-TLS relay on one explicit private LAN
address; Chrome DevTools remains on loopback. Optional multi-host mode adds one
user-configured Mac listener reachable through SSH or inside the encrypted
tailnet; titles, task IDs, states, a bounded catalog of recent local task UUIDs
and modification times, ownership metadata, and typed commands pass between the
paired machines and nowhere else.

## Compatibility boundary

This is not a public Codex extension API. Export names, internal commands, or event shapes can change. The code avoids fixed bundle hashes where possible, but semantic changes still require a release update.
