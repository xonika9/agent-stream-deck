# OpenCode compatibility

The first OpenCode integration targets the maintainer's characterized setup:

- macOS;
- OpenCode Desktop `2.0.5`;
- the managed local `sidecar` service;
- saved SSH connections that authenticate non-interactively through the user's
  existing SSH configuration.

It deliberately does not inspect OpenCode's renderer SQLite database. The local
service comes from its private service registration. Saved SSH connections come
from the user-owned `opencode.settings` file; because OpenCode Desktop currently
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

Connection targets, service URLs, passwords, raw task titles, locations,
messages, permission resources, form contents, costs, and token counts remain
inside the transport adapter. The queue receives only opaque connection and
session IDs, content-free `OpenCode N` labels, normalized state, and bounded
timestamps.

Compatibility must fail closed when descriptor checks, loopback validation,
authentication, response bounds, or the characterized `2.0.5` response shapes
do not match.
