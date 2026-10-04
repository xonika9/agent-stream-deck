# Repository instructions

## Setup and validation

- Use Node.js 24 or newer and install dependencies with `npm ci`.
- For code changes, run `npm run check`, `npm test`, and `npm run validate`.
- Never create branches — always commit and work directly on `main`.
- For iOS changes, also run:

  ```zsh
  xcodebuild -project ios/CodexDeckMobile.xcodeproj \
    -scheme CodexDeckMobile \
    -destination 'generic/platform=iOS' \
    CODE_SIGNING_ALLOWED=NO build
  ```

- Run `npm run audit:release` after building release artifacts.
- Report automated, live-app, and physical-device validation separately. Never describe fixture, compile, build, or package validation as physical-device testing.

## Project invariants

- Develop primarily for Mac and preserve standalone Windows installation, startup, and existing actions. Keep Mac task-source modes `Codex`, `OpenCode`, and `Both`, including local OpenCode and saved Fedora SSH connections. Fedora is a chat source, not a Stream Deck plugin platform.
- The product is retiring the iPhone application and separate multi-host Codex relay. Remove them in their planned implementation units; preserve all existing functions during the SDK/dependency upgrade. Do not remove other functions without a separate decision.
- Keep the Codex Chrome DevTools endpoint bound to loopback. Do not expose, forward, or rebind it to a network interface; preserve the authenticated, identity-checked OpenCode SSH path documented in `SECURITY.md`. Existing relay security restrictions continue to apply until its removal.
- Do not add hotkey or task-database fallbacks to the native bridge without a separate design decision.
- Do not commit or distribute proprietary OpenAI or Elgato assets, Codex installation files, databases, logs, rollout files, pairing tokens, personal paths, private runtime state, or generated release bundles.
- Update compatibility notes when renderer integration behavior changes.

See `CONTRIBUTING.md` for the pull-request contract and `SECURITY.md` for the complete security boundary.
