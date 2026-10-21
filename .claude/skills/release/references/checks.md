# Release gate

Run from the repository root with Node.js 24 or newer:

```bash
npm ci
npm run release:prepare -- --version X.Y.Z
git diff --check
```

`release:prepare` runs the complete automated checks required by `CONTRIBUTING.md`, packages the plugin and launchers, and audits the checksummed output. Inspect `scripts/prepare-release.mjs` against that contract if either changes; do not run the same checks separately before the script.

When this skill changes, use `x9-skill-creator` for structural validation. Tests of that validator belong only to changes to the validator itself; neither is an ordinary product release prerequisite.

On a platform other than macOS, pass a supplied macOS-built archive with `npm run release:prepare -- --version X.Y.Z --mac-archive /path/to/archive.zip`. Without a supplied archive, the candidate omits the macOS ZIP.

Inspect `outputs/release-vX.Y.Z/` and require:

- `com.xonika9.codex-deck.streamDeckPlugin`;
- `codex-deck-launcher-windows-vX.Y.Z.zip`;
- `codex-deck-launcher-macos-vX.Y.Z.zip` when preparing on macOS or when a macOS-built archive was supplied;
- `SHA256SUMS.txt`, containing every other artifact exactly once with LF line endings.

Then run:

```bash
unzip -t outputs/release-vX.Y.Z/codex-deck-launcher-windows-vX.Y.Z.zip
(cd outputs/release-vX.Y.Z && shasum -a 256 -c SHA256SUMS.txt)
```

When preparing on macOS or including a supplied macOS archive, also run:

```bash
unzip -t outputs/release-vX.Y.Z/codex-deck-launcher-macos-vX.Y.Z.zip
```

The macOS archive must be built on macOS, or supplied from a macOS build, because executable modes are part of that artifact's contract. The iPhone product and its source have been removed in 2.0.0. Do not require an iOS build for that deletion; validate absence from maintained entry points and release artifacts.

Record each command and result. A missing executable, dependency, credential, artifact, or permission blocks the gate; do not silently skip it.
