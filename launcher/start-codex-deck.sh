#!/bin/zsh
set -euo pipefail

script_dir="${0:A:h}"
runtime="$script_dir/codex-deck-macos.mjs"

if [[ ! -f "$runtime" ]]; then
  print -u2 "Codex Deck: bundled macOS runtime is missing. Run npm run build first."
  exit 1
fi

node_candidates=()
if command -v node >/dev/null 2>&1; then node_candidates+=("$(command -v node)"); fi
node_candidates+=(/opt/homebrew/bin/node /usr/local/bin/node)
for node_candidate in "$HOME"/.nvm/versions/node/*/bin/node(N); do
  node_candidates+=("$node_candidate")
done
for app_candidate in /Applications/Codex.app /Applications/ChatGPT.app; do
  node_candidates+=("$app_candidate/Contents/Resources/cua_node/bin/node")
done

for node_candidate in "${node_candidates[@]}"; do
  [[ -x "$node_candidate" ]] || continue
  node_version=$("$node_candidate" --version 2>/dev/null) || continue
  node_major=${${node_version#v}%%.*}
  [[ "$node_major" == <-> && "$node_major" -ge 24 ]] || continue
  exec "$node_candidate" "$runtime" "${@:-start}"
done

print -u2 "Codex Deck: Node.js 24 or newer was not found in PATH, Homebrew, NVM, or the Codex app bundle."
exit 1
