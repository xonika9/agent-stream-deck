# Contributing

Thanks for helping improve Codex Deck.

Use Node.js 24 or newer for development and launchers. The plugin uses SDK 3
and requires Stream Deck 7.1 or newer.

Mac is the primary platform; standalone Windows installation, startup, and
existing actions remain supported. Mac retains `Codex`, `OpenCode`, and `Both`,
with local OpenCode and saved Fedora SSH connections. Fedora supplies chats
rather than running the Stream Deck plugin. The iPhone app and its infrastructure have been removed. The separate Codex
relay has been removed; preserve old private settings and ignore remote selections. Other removals need a separate decision.

## Local Stream Deck development

Build and link the development plugin once:

```sh
npm run build
streamdeck dev
streamdeck link dist/com.xonika9.codex-deck.sdPlugin
```

Then keep this command running while editing `src/` or `static/`:

```sh
npm run dev
```

It rebuilds the plugin and restarts only `com.xonika9.codex-deck` after a
successful change. It does not restart the Stream Deck app, Codex, or the
platform watcher. Because the fork uses a distinct UUID, create a separate
development profile with the fork's actions instead of editing or overwriting an
upstream profile.

The installed macOS watcher is a copied runtime, not a live source link. Rebuild
and reinstall it only when launcher or watcher behavior changes:

```zsh
npm run build
release/codex-deck-launcher-macos/start-codex-deck.sh install
```

## Before opening a pull request

1. Preserve the supported Mac and standalone Windows paths, Mac task-source modes, and OpenCode SSH connections. State clearly which paths received automated, live-app, and physical-device testing.
2. Do not commit OpenAI/Elgato proprietary assets, Codex installation files, databases, logs, rollout files, personal paths, or generated release bundles.
3. Do not add hotkey or task-database fallbacks to the native bridge without a separate design discussion.
4. Update compatibility notes when changing renderer integration behavior.
5. Install and run the automated checks:

```sh
npm ci
npm run lint
npm run check:boundaries
npm run check
npm test
npm run validate
```

6. Build distributable Stream Deck artifacts with:

```sh
npm run pack
```

After all release artifacts have been built, audit the complete artifact set:

```sh
npm run audit:release
```

Pull requests should explain the tested Codex version, Stream Deck version,
operating system, hardware model, and manual verification performed. Report
automated checks, live-app verification, and physical-device verification as
separate evidence. Never describe fixture, compile, build, or package validation
as physical-device verification.

Current acceptance must distinguish automated checks, live application scenarios, and physical Stream Deck testing. Local packaging does not establish Windows execution or device behavior. Launcher archives contain only supported public guides and explicit assets, not plans or maintenance evidence.
