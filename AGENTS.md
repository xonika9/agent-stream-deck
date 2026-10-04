# Repository instructions

## Setup and validation

- Use Node.js 24 or newer and install dependencies with `npm ci`.
- For code changes, run `npm run check`, `npm test`, and `npm run validate`.
- Never create branches — always commit and work directly on `main`.
- Run `npm run audit:release` after building release artifacts.
- Report automated, live-app, and physical-device validation separately. Never describe fixture, compile, build, or package validation as physical-device testing.

## Project invariants

- Develop primarily for Mac and preserve standalone Windows installation, startup, and existing actions. Keep Mac task-source modes `Codex`, `OpenCode`, and `Both`, including local OpenCode and saved Fedora SSH connections. Fedora is a chat source, not a Stream Deck plugin platform.
- The iPhone application and its infrastructure have been removed. The separate multi-host Codex relay has been removed; old private settings remain preserved and ignored. Do not remove other functions without a separate decision.
- Keep the Codex Chrome DevTools endpoint bound to loopback. Do not expose, forward, or rebind it to a network interface; preserve the authenticated, identity-checked OpenCode SSH path documented in `SECURITY.md`.
- Do not add hotkey or task-database fallbacks to the native bridge without a separate design decision.
- Do not commit or distribute proprietary OpenAI or Elgato assets, Codex installation files, databases, logs, rollout files, pairing tokens, personal paths, private runtime state, or generated release bundles.
- Update compatibility notes when renderer integration behavior changes.

See `CONTRIBUTING.md` for the pull-request contract and `SECURITY.md` for the complete security boundary.
