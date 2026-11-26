# Local Codex Micro icon setup

Agent Deck does not distribute the official Codex Micro keycap SVGs. This workflow keeps exact local copies outside the repository and release.

## Destination

Use the directory for the computer running Stream Deck:

```text
Windows: %LOCALAPPDATA%\AgentDeck\icons
macOS:   ~/Library/Application Support/AgentDeck/icons
```

Each SVG must be named after its Codex keycap ID. The known IDs in the tested Codex build are:

```text
FAST APPR REJ SPLIT MIC CODEX BUG OAI TERM DWN DEL NEW NAV MAGIC DIFF
PLAY GIT BRCH MRG PR PAINT LAB PARTY TIME MIND+ MIND- SETUP FOLD UPL APPS
```

Example destination names:

```text
%LOCALAPPDATA%\AgentDeck\icons\FAST.svg
%LOCALAPPDATA%\AgentDeck\icons\APPR.svg
%LOCALAPPDATA%\AgentDeck\icons\MIND+.svg
```

The plugin reads matching files for the six synchronized physical action slots
and for the standalone keycap actions. If a file is unavailable, the key still
receives a readable themed label instead of remaining blank.

## Ask Codex to copy the existing files locally

Run this on the same computer as the Codex installation. Replace `<ICON_DIRECTORY>` with the platform destination above:

```text
Inspect my locally installed Codex desktop app and locate the official Codex Micro keycap SVG files that are already present on this machine. Do not redraw, modify, generate, download, upload, publish, or commit them. Copy the exact local SVG files into <ICON_DIRECTORY> and rename each copy to its Codex keycap ID, such as FAST.svg, APPR.svg, REJ.svg, SPLIT.svg, MIC.svg, MIND+.svg, and MIND-.svg. Keep the source files unchanged. Verify that every copied file is a valid SVG with a viewBox, confirm that the destination is outside the Git repository, and report only the source location, destination location, filenames, and validation result. If the assets cannot be confirmed as files from my local Codex installation, stop without copying anything.
```

This prompt intentionally limits the work to files already present in your installation and explicitly prevents them from entering the public repository.

## Refresh

After changing files, restart the Stream Deck app or remove and re-add the affected action. Agent Deck caches successfully loaded keycaps for the current plugin process.

## Rights

You are responsible for ensuring your use of third-party assets is permitted. The Agent Deck license covers only this repository's code and original artwork.
