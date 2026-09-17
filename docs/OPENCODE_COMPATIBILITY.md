# OpenCode compatibility

This document records the private-contract feasibility gate for the planned
unified Codex and OpenCode queue. It is not a support promise for OpenCode
Desktop, and it contains no copied user configuration or runtime data.

## Gate result

**Overall result: `no-go`.** Do not start the production adapter, collector,
relay, settings, or rendering units until the WSL and live-WAL rows below have
safe designs and every runtime row has passed in CI.

| Contract | Result | Evidence |
| --- | --- | --- |
| Managed local service | `go` on OpenCode Desktop `2.0.5` | A descriptor-checked `0600` service registration produced one bounded, authenticated loopback session-list response without launching a service or exposing its endpoint or password. |
| Renderer registry shape | `go` on OpenCode Desktop `2.0.5` | The `opencode.global.dat` / `server` state row was decoded from `drafts.sqlite` while Desktop held a live WAL. No row values or local paths were retained. |
| Live-WAL side effects | `no-go` for the selected SQLite candidate | A synthetic probe read committed WAL data with `OPEN_READONLY`, but content hashing detected a change to `probe.sqlite-shm`. SQLite read-only mode does not satisfy the plan's no-hidden-write requirement by itself. |
| Saved HTTP policy | `fixture-required` | The inspected profile contained no saved HTTP connection. Production work must still prove literal-loopback HTTP and remote HTTPS policy from manually constructed fixtures. |
| Saved SSH connection | `go` for the inspected non-interactive profile | One bounded session-list request succeeded through an SSH loopback forward with `BatchMode=yes`. The password stayed in process memory, a hostile pre-bind caused fail-closed startup, and the process group was terminated. No host, endpoint, path, or credential was recorded. |
| Ready WSL connection | `no-go` | Desktop `2.0.5` keeps the ready sidecar URL and password in transient controller/IPC state. Its external command path calls `wsl.exe` to resolve or start the sidecar. If a distribution stops between a “running” check and that command, Windows starts it. No authenticated attach-only broker or no-start WSL command was found. |
| Native SQLite on macOS arm64 | `load-go` locally | The hash-pinned `sqlite3@6.0.1` binary loaded under Node `20.20.2`; the separate live-WAL safety row remains `no-go`. |
| Native SQLite on macOS x64 | `load-go` locally under Rosetta | The same hash-pinned N-API candidate loaded under x64 Node `20.20.2`; content-level WAL side effects were not separately cleared. |
| Native SQLite on Windows x64 | `pending` | The pinned upstream binary and hash are declared in the probe, but the load test has not run on a Windows host in this worktree. |

The saved-connection inventory is intentionally represented only as supported
or absent. Counts, names, URLs, targets, paths, task titles, session records,
and raw persistence values are not part of this receipt.

## Characterized persistence profile

OpenCode Desktop `2.0.5` stores renderer state in `drafts.sqlite`:

- table: `state`;
- namespace: `opencode.global.dat`;
- key: `server`;
- saved HTTP entries: the `list` field in the decoded value;
- saved SSH entries: the `ssh.servers` key in `opencode.settings`;
- saved WSL entries: the `wslServers` key in `opencode.settings`.

The session API returns a paginated object with `data` and a `cursor` object;
the next request uses `cursor.next`. Current pending-attention routes are
`/api/permission/request` and `/api/form`, and active executions are available
at `/api/session/active`. These shapes remain private and must be rejected or
marked incompatible when strict projection fails.

## Native SQLite candidate

The feasibility harness pins `sqlite3@6.0.1`, N-API v6 archives, and the exact
archive and extracted-binary SHA-256 values in
`scripts/opencode-feasibility/native-sqlite.ts`. CI installs package JavaScript
with lifecycle scripts disabled, verifies and extracts the selected archive,
and only then imports the native addon. The declared matrix is:

- macOS arm64, Node 20 and 24;
- macOS x64, Node 20 and 24;
- Windows x64, Node 20 and 24.

Node `20.17.0` is the minimum because that is the package's declared runtime
floor. Passing the repository test from a dependency checkout is only U1
evidence. Production packaging must later prove offline loading from the built
plugin, launcher, and installed LaunchAgent-shaped locations.

The current candidate cannot yet be productionized. `OPEN_READONLY` still uses
the WAL shared-memory index and changed its content in the synthetic probe. A
replacement must either provide a truly non-writing VFS/read path or take a
consistent descriptor-bound snapshot without touching source DB/WAL/SHM files
and without introducing an unaudited parser.

## Why WSL blocks implementation

The `2.0.5` Desktop source establishes all three relevant facts:

1. `packages/desktop/src/main/wsl/servers.ts` stores a ready server's URL and
   password in the in-memory `sidecars`/runtime state.
2. `packages/desktop/src/main/wsl/ipc.ts` exposes that state only through
   Electron `WebContents` request/subscription methods.
3. `packages/desktop/src/main/wsl/sidecar.ts` creates the password and launches
   `wsl` to run the service; it does not publish an external authenticated
   registration on Windows.
4. `packages/desktop/src/main/wsl/runtime.ts` implements distro access by
   invoking `wsl`.

A bounded search of the `2.0.5` WSL main-process modules, shared IPC-RPC
definitions, server registry, and persistence modules found no external
authenticated ready-state broker. Microsoft documents `wsl --list --running`
as a point-in-time list and `wsl --distribution <name>` as the command that runs
a distribution: <https://learn.microsoft.com/windows/wsl/basic-commands>.

A check-then-invoke sequence cannot close the stop race. Reading process memory,
Chromium storage, or private IPC by injection is outside the security contract.
Therefore the current all-connections requirement needs one of these upstream
capabilities before implementation can resume:

- an authenticated Desktop broker that returns already-ready connection DTOs;
- a descriptor or handle whose use fails rather than starting a stopped WSL
  distribution; or
- a product decision that removes WSL from the mandatory release gate.

## Unfinished measurements

Response, pagination, event-burst, reconciliation-time, candidate, and relay
budgets were not frozen after the mandatory WSL and live-WAL rows failed. Local exploratory
measurements contained private runtime-derived values and were deliberately not
committed. Repeat the bounded characterization after the WSL design changes;
then add boundary and boundary-plus-one fixtures before changing production
code.
