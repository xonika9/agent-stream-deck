# T3 Code task source

The macOS Agent selector adds `T3 Code` and `All` (all three sources).
Legacy `Both` settings resolve to `All`; the selector offers only the three
individual sources and `All`. All external sources force Active queue without
changing the saved Codex preference. Windows installation and existing actions
are unchanged; T3 Code collection is currently macOS-only.

## Connect the local server

Start T3 Code normally. Create a one-time pairing credential with its own CLI,
then pipe the JSON directly into the connector:

```sh
t3 auth pairing create --label CodexDeck --json | npm run connect:t3
```

If `t3` is not installed on PATH, use the CLI bundled with the desktop app.
For the characterized nightly macOS application:

```sh
ELECTRON_RUN_AS_NODE=1 '/Applications/T3 Code (Nightly).app/Contents/MacOS/T3 Code (Nightly)' '/Applications/T3 Code (Nightly).app/Contents/Resources/app.asar/apps/server/dist/bin.mjs' auth pairing create --label CodexDeck --json | npm run connect:t3
```

Running this command creates a separate T3 client session. The connector
exchanges the one-time credential for only `orchestration:read`, verifies the
shell endpoint, and stores the bearer token in the current user's
`~/Library/Application Support/CodexDeck/t3code.json` with mode `0600`.
Do not paste credentials into chat or Stream Deck settings. Expired or revoked
sessions require connecting again. The plugin never issues credentials itself.

The adapter reads `~/.t3/userdata/server-runtime.json`, checks that the recorded
process is alive and its origin matches the connection, and sends only loopback
HTTP requests. A changed server port requires connecting again. Custom base
folders and remote T3 servers are outside this initial integration.

## Queue behavior

The source uses `GET /api/orchestration/shell` with
`x-t3-orchestration-protocol: 2`. It consumes V2 thread status, pending runtime
requests, proposed plans, background work, run timestamps and `lastVisitedAt`.
It never opens T3's database, decrypts desktop credentials, dispatches commands,
or changes provider/model settings. Shell message previews and private project
metadata are discarded inside the adapter; only bounded sanitized task titles,
opaque IDs, normalized states and timestamps reach the renderer.

Pending input/approval/plans appear orange; preparing/queued/starting/running
work appears blue; fresh completion appears green; failed results appear red.
Archived, deleted, settled, snoozed, idle and interrupted chats are omitted.
Completed/failed results expire five minutes after their terminal timestamp and
are omitted when T3 reports they have already been visited. A press foregrounds
T3 Code and acknowledges only the exact displayed terminal revision locally.
It does not navigate to a specific chat or publish a visited update. A newer
terminal timestamp admits the result again. Key-up sends no Codex command.
T3 keys display `T3` and have no Codex context ring.

Missing credentials, unsupported response shapes, HTTP failure, excessive
response size or timeouts produce degraded health and clear stale tasks.
HTTP requests have a four-second budget and a two-MiB response limit.
Acknowledgements are process-local and are never distributed or persisted.

## Evidence

The adapter contract was checked against the installed T3 Code Nightly `0.0.46-nightly.20261005.2689` V2
schemas and protocol header on 2026-10-05. The nearby source checkout used an
older orchestration shape and was not used as the final runtime contract.
Automated HTTP fixtures exercise authenticated collection, selection and
revision acknowledgement. Build/package checks do not establish live-app or
physical Stream Deck acceptance. Live acceptance requires creating the separate
connection above and checking running, approval, completion and failure states
in the installed plugin; physical-device testing must be recorded separately.
