# Version selection

Compare the complete candidate with the latest public tag and let the strongest public change determine the bump.

- Before `1.0.0`, use `PATCH` for compatible corrections and `MINOR` for new capabilities or intentional changes to behavior, installation, or supported environments.
- Use `1.0.0` only after the maintainer explicitly accepts this repository's public identity and compatibility boundary as the first stable release line.
- After `1.0.0`, use `MAJOR` for incompatible public-contract changes, `MINOR` for backward-compatible capabilities, and `PATCH` for backward-compatible corrections.
- A mixed release takes the highest applicable bump. Stream Deck release `X.Y.Z.0` maps to npm and GitHub version `X.Y.Z`; a later Stream Deck hotfix `X.Y.Z.W` maps to npm SemVer `X.Y.Z-hotfix.W` and GitHub version `X.Y.Z.W`.

For a new release, before editing release files, verify that neither `refs/tags/vX.Y.Z` nor a GitHub Release for that version exists. Released versions are immutable. For an interrupted publication, follow [publishing.md](publishing.md) and retain the existing candidate and version.

When confirmation is missing, use the runtime's structured user-input tool when available. Present the recommended version, the changes that determine it, and an option to supply another version. A plain answer is acceptable when the maintainer already made an unambiguous version decision in the same task.
