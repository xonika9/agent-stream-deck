# OpenCode compatibility

The first OpenCode integration targets the maintainer's characterized setup:

- macOS;
- OpenCode Desktop on macOS, validated against `2.0.5`;
- the managed local `sidecar` service;
- saved SSH connections that authenticate non-interactively through the user's
  existing SSH configuration.

It deliberately does not inspect OpenCode's renderer SQLite database. The local
service comes from its private service registration. Saved SSH connections come
from the user-owned `opencode.settings` file; a CLI-managed remote service may
instead supply bounded pairing and authenticated identity output entirely inside
the SSH adapter. Because OpenCode Desktop currently
writes that file as `0644`, Codex Deck accepts it only when its owner is the
current user and group/other users cannot modify it.

## Out of scope

- WSL connections;
- saved HTTP connections;
- unknown future persistence or API shapes;
- interactive SSH authentication;
- launching a stopped local or remote OpenCode service.

Unsupported connection kinds are ignored. Codex Deck never invokes `wsl.exe`,
never opens `drafts.sqlite`, and never reads OpenCode process memory or Chromium
storage.

## Private-data boundary

Connection targets, service URLs, passwords, locations, messages, permission
resources, form contents, costs, and token counts remain inside the transport
adapter. The queue receives opaque connection and session IDs, stable
content-free `OpenCode N` fallback labels, normalized state, bounded timestamps,
and a bounded, sanitized task title for the same-process local Stream Deck
renderer. The title is never logged, diagnosed, relayed, or packaged.

Compatibility is capability-based rather than pinned to one exact version.
Registration and authenticated service versions and process IDs must match, and
descriptor checks, loopback validation, authentication, response bounds, and
the characterized API shapes must all pass. A future version with matching
capabilities remains available; a mismatched capability fails only that
connection closed.

OpenCode `2.0.5` does not consistently publish `time.viewed` for remote roots.
The collector still honors that source field when present, but a Stream Deck
key-down locally acknowledges only the currently displayed completion or error.
That acknowledgement is in-memory, is never sent to OpenCode or a relay, and is
invalidated by a later terminal timestamp for the same opaque task identity.
When no Codex renderer snapshot is available to supply a theme, OpenCode Agent
keys use the renderer's light fallback rather than changing to dark.
