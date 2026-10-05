# Release gate

Run from the repository root with Node.js 24 or newer:

```bash
npm ci
npm run lint
npm run check:boundaries
npm run check
npm test
npm run validate
npm run release:prepare -- --version X.Y.Z
python3 <resolved-x9-skill-creator-directory>/scripts/validate.py \
  --runtime portable --runtime claude --runtime codex .claude/skills/release
python3 <resolved-x9-skill-creator-directory>/scripts/test_validate.py
git diff --check
```

Resolve the placeholders from the live `x9-skill-creator` installation; do not substitute a different validator silently.

Inspect `outputs/release-vX.Y.Z/` and require:

- `com.xonika9.codex-deck.streamDeckPlugin`;
- `codex-deck-launcher-windows-vX.Y.Z.zip`;
- `codex-deck-launcher-macos-vX.Y.Z.zip` when preparing on macOS or when a macOS-built archive was supplied;
- `SHA256SUMS.txt`, containing every other artifact exactly once with LF line endings.

Then run:

```bash
npm run audit:release -- outputs/release-vX.Y.Z
unzip -t outputs/release-vX.Y.Z/codex-deck-launcher-windows-vX.Y.Z.zip
unzip -t outputs/release-vX.Y.Z/codex-deck-launcher-macos-vX.Y.Z.zip
(cd outputs/release-vX.Y.Z && shasum -a 256 -c SHA256SUMS.txt)
```

The macOS archive must be built on macOS, or supplied from a macOS build, because executable modes are part of that artifact's contract. The iPhone product and its source have been removed in 2.0.0. Do not require an iOS build for that deletion; validate absence from maintained entry points and release artifacts.

Record each command and result. A missing executable, dependency, credential, artifact, or permission blocks the gate; do not silently skip it.
