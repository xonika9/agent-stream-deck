#!/bin/zsh
set -euo pipefail

ROOT="${0:A:h:h}"
PACKAGE_VERSION="$(node -p "require('$ROOT/package.json').version")"
VERSION="${CODEX_DECK_RELEASE_VERSION:-$PACKAGE_VERSION}"
OUTPUT="${1:-$ROOT/outputs/agent-deck-launcher-macos-v$VERSION.zip}"
mkdir -p "${OUTPUT:h}"
rm -f "$OUTPUT"
chmod 755 "$ROOT/release/agent-deck-launcher-macos/start-agent-deck.sh" "$ROOT/release/agent-deck-launcher-macos/Start Agent Deck.command"
# Source archives do not need Finder metadata or local provenance xattrs. Omitting
# resource forks also avoids a noisy __MACOSX directory in the public ZIP while
# the ZIP format still preserves the executable mode set above.
ditto -c -k --norsrc --keepParent "$ROOT/release/agent-deck-launcher-macos" "$OUTPUT"
echo "macOS launcher archive created: $OUTPUT"
