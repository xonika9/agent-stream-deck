# Testing

Rules for people and agents changing tests in this repository. Setup and the
full validation list live in `CONTRIBUTING.md`.

## Commands

```sh
npm test                                                  # whole suite, about 20 s
npx tsx --test test/controller.test.ts                    # one file
npx tsx --test --test-name-pattern="usage selection" test/usage.test.ts  # by name
```

Before a commit, run the full set from `CONTRIBUTING.md`: `npm run lint`,
`npm run check:boundaries`, `npm run check`, `npm test`, `npm run validate`.
After building release artifacts, run `npm run audit:release`.

## Where tests run

- **Locally:** the whole suite. It is fast enough that there is no affected-only mode.
- **CI** (`.github/workflows/ci.yml`): every push to `main` and every pull request,
  on `macos-15` and `windows-2025`, runs the same five checks. A red step fails
  the run. Work lands directly on `main`, so CI reports after the push: when it
  is red, fix forward at once if the cause is obvious, otherwise revert first.
- **Platform-only tests** declare it with a skip and a reason, for example
  `{ skip: process.platform === "win32" }`. OpenCode, T3 Code, the macOS
  launcher, and CodexBar tests skip on Windows. The PowerShell watcher and
  updater tests run only on Windows, so only the Windows CI job proves them.

## Writing a test

Before adding one, know the behavior it protects, a realistic bug that would
make it fail, and that the nearest existing tests do not already catch it.
Test at the public boundary of the module that owns the behavior:

- **Stream Deck controller:** construct `DeckController` with stub sources,
  register fake `KeyAction`s, and assert the rendered images. Do not read or
  write private fields.
- **Codex renderer expressions** (`src/codex/bridge.ts`, `runtime-override.ts`,
  `active-catalog-expression.ts`): capture the expression and run it in
  `node:vm` against fake renderer modules, as `test/micro-bridge.test.ts` and
  `test/launcher.test.ts` do.
- **Property inspectors:** run the page script against a fake DOM and socket,
  as `test/agent-settings.test.ts` does.
- **Scripts:** extract the logic into an importable module and run it on a
  temporary directory, as `scripts/finalize-release.mjs` is.

Expected values are literals, never values exported by the code under test.
Do not export a symbol only for tests. Reading source text is allowed only for
an external contract that no harness can execute, such as a Codex field name, a
PowerShell mutex, or a packaging allowlist. Keep a comment saying why.

## Isolation and timing

- Work in `mkdtemp` directories. Override `HOME` and `LOCALAPPDATA` for code
  that resolves state paths. Never touch the real home directory, a real Codex
  install, or a real Stream Deck.
- Use `context.mock.timers` for polling and animation. Do not prove a negative
  with a fixed sleep: wait for an observable marker, such as the lock-contention
  file in `test/t3code-lock.test.ts`.
- Fixtures must not depend on tools installed on the machine. The macOS launcher
  test supplies its own Node 24 for exactly this reason.

## Red and flaky tests

- Never weaken an assertion, add a skip, or delete a test only to get green.
- The runner has no retries. A test that passes only on rerun is a bug: fix it
  or delete it with evidence that another test protects the behavior.
- Coverage has no threshold. Use it only to find code that nothing runs.

## Reporting

Report automated, live-app, and physical-device validation separately. Fixture,
compile, build, or package validation is never physical-device testing.
