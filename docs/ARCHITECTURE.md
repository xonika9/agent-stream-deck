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
The local queue uses that identity. Old Codex relay settings and private tokens are ignored without rewriting or deleting them.

### Stream Deck plugin

The same plugin runs on Windows and macOS. It discovers the local loopback port from the platform state file or from a running Codex process. It then uses Chrome DevTools Protocol `Runtime.evaluate` calls to:

1. discover the current version-hashed Codex renderer modules;
2. announce a connected Micro device state;
3. read the mandatory native six-slot state, layout, agent source, and lighting preference, then optionally discover the bounded native pinned + unpinned sidebar catalog;
4. dispatch Micro HID and joystick events;
5. emulate native encoder-rotation HID events for reasoning-effort changes;
6. resolve standalone keycap actions from Codex's live Micro keycap registry and current official command runner;
7. read Codex's renderer-owned `rate-limit-status` query and normalize its current 5-hour, weekly, and reset-credit state.

On newer Codex builds, the native Micro pinned atom can retain an older list.
Pinned mode reads the current sidebar rows in display order, including their
live status, and dispatches their exact thread identities rather than relying
on native slot order. The last observed pinned list is retained while rows are
collapsed, with cached selection flags cleared to prevent falsely acknowledging
a completed task after switching chats. A verified empty semantic pin list
clears that cache after the final pin is removed. Older builds fall back to native slots. Other source modes retain
native Micro slots, and full active-catalog discovery still uses the original
native slots before the pinned display override. Active chat detection prefers
the selected sidebar identity and only considers visible composers.
The launcher also discovers the native event bus in `app-shared` chunks.

This integration is adapted from crunchy234's
[`ed6c97e`](https://github.com/crunchy234/codex-stream-deck/commit/ed6c97e4a608d72b5f897f9e5963c27ed363f08a),
while preserving strict host identity matching in this fork.

The bridge does not emulate a USB HID device and installs no driver.

For the characterized macOS OpenCode setup, the plugin starts a separate
collector only when the global Agent source is `OpenCode` or `Both`. It discovers
the managed local service from its user-owned loopback registration and saved SSH
connections from `opencode.settings`. SSH uses non-interactive authentication and
a temporary loopback forward. If a CLI-managed remote service has no registration
file, bounded `opencode pair` and authenticated `opencode api` output supply the
same private registration inside the adapter. Compatibility is decided from the
authenticated identity and bounded API shapes rather than an exact version. The adapter publishes only opaque identities,
content-free labels, normalized state, and bounded timestamps. It does not open
OpenCode SQLite, invoke WSL, launch a stopped service, or expose connection and
task content.

### Active queue projection

`Active queue` is a plugin display option shared by all six Agent actions on one
computer. An absent or false setting leaves the current native local agent-source result unchanged. When enabled outside
`custom`, the controller reads the local authoritative native pinned +
unpinned sidebar catalog, resolves trusted conversation mirrors and ownership,
and only then projects at most six display positions. An absent catalog falls
back locally to its six Micro slots; an authoritative empty catalog remains
empty. `custom` keeps its six configured candidates instead of expanding to the
full catalog; the projection may still compact relevant candidates within that set.

The sidebar reader supports both the legacy attention/recency maps and the
split sidebar structure characterized on macOS with Codex `26.930.31730`.
For the split structure it reads full task summaries, including canonical
conversation IDs, runtime status, unread state, titles, and recency. Lightweight
navigation metadata is not a task-state source. Native Micro slots retain status
priority, and a versioned resolver cache prevents an older plugin's discovery
failure from surviving a plugin update. Windows behavior retains
the legacy path; this newer renderer shape has only been checked live on macOS.

The global task-source selector runs before this projection. `Codex` preserves
the saved Active queue preference; `OpenCode` and `Both` force the projection
without overwriting that preference. OpenCode candidates use the same
attention/completion/working groups but keep case-sensitive opaque identities
and never receive a context ring. An OpenCode key-down foregrounds OpenCode
Desktop and acknowledges the exact currently displayed terminal revision in the
collector's process-local state; key-up is intentionally a no-op. After local
removal, the collector best-effort publishes the same revision through
OpenCode's authenticated `session.view` route. Unsupported routes and transport
failures leave the local acknowledgement intact. A later terminal timestamp
clears that acknowledgement and becomes visible again. No viewed state or raw
OpenCode connection material is written to a relay. Terminal history older than
five minutes at first observation is treated as the startup baseline and is not
backfilled. Once a newer successful or failed terminal result is admitted, it
remains until source-viewed, locally acknowledged, or five minutes have elapsed
from its normalized terminal event; polling may delay removal by up to one cycle.

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

Local snapshot activity, exact task identity, and timestamps live in `codex-local-state.ts`, independently of network transport. Only a trusted local rollout owner contributes the atomic `workStartedAt` / `workStartRevision` pair; temporary task aliases do not borrow it. Agent key-down saves the exact assignment or empty position by action context. Queue changes and duplicate instances of the same slot cannot change the corresponding release; disappearance clears only that instance's captured state.


Usage data remains local and account-scoped. On macOS, quota windows come from the newest valid CodexBar `widget-snapshot.json` Codex entry and expire after five minutes; this path does not start or attach Codex Desktop and does not fall back to renderer quota from another host. Reset-credit counters may still be overlaid from an already-attached local Codex bridge. Windows retains the local renderer-owned usage query. Window identity is derived from duration rather than primary/secondary ordering. A missing 5-hour window is unavailable, and Automatic mode falls back to weekly. Usage controls display and fill the consumed percentage while retaining warning colors derived from remaining capacity. Without a renderer theme, usage controls use the same light fallback as OpenCode Agent keys.

Reset consumption is the only mutating usage operation. It calls Codex's current native reset-credit client only after the Stream Deck key has been held for 1.2 seconds. The bridge verifies both availability and applicability, selects an available plan-supported credit, uses a unique redemption request ID, and then refreshes the renderer query. No credential, raw endpoint access, or arbitrary request surface is exposed by the plugin.

### Local connection status

The existing `host-toggle` action keeps its UUID for saved profiles. It displays the local platform and connection health; pressing it redraws that status without changing the target. Every Codex command executes through the local native bridge. The watcher has no Codex relay listener or managed relay SSH tunnel. Saved OpenCode SSH connections stay with the OpenCode collector and retain their authenticated loopback path.

An installed watcher is a copied runtime. Reinstall the matching new launcher to replace it; a source build alone does not update or stop the old installed process. Stable host identity, user icons, and legacy private files remain preserved.

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

Codex Deck has no Codex relay server, analytics endpoint, or update service. Runtime data stays between Stream Deck, the local plugin, the local Codex renderer, and selected OpenCode services. OpenCode's existing SSH path may reach saved Fedora connections through an authenticated temporary loopback forward. Endpoints, targets, credentials, messages, locations, and permission/form content remain inside that adapter and are not logged or rendered. A bounded, sanitized OpenCode task title flows only into the same-process local Stream Deck renderer. No old relay token or private runtime state belongs in a release.

## Compatibility boundary

This is not a public Codex extension API. Export names, internal commands, or event shapes can change. The code avoids fixed bundle hashes where possible, but semantic changes still require a release update.
