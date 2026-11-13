---
name: release
description: Use in this repository when the maintainer asks to prepare or publish a Codex Deck release — «подготовь релиз», «выпусти релиз», «зарелизь новую версию», "prepare a release", "publish the release". Do not use for an ordinary changelog edit, build, commit, push, or pull request.
---

# Release

Prepare or publish a Codex Deck version from the complete repository state. The latest public tag, its full diff to the candidate, the package and Stream Deck manifests, `CHANGELOG.md`, release documentation, and the generated artifact audit are the sources of truth.

This is a private repository-local skill. Its canonical source is `.claude/skills/release`; `.agents/skills` exposes the same source through a repository-relative symlink.

## Select the mode

- **Prepare** applies when the maintainer asks for a release candidate. It may update local release files and build artifacts, but stops before commit, push, tag, or GitHub Release.
- **Publish** applies only when the maintainer explicitly asks to release or publish. It includes preparation, committing the coherent candidate, pushing `main`, creating the immutable tag, and publishing the GitHub Release.

An ordinary request to edit release-adjacent files or push unrelated work is not publish authority. Preserve unrelated work and secrets; never discard changes, rewrite history, force-push, or move an existing tag.

## Establish the candidate

Resolve the repository root with Git, then inspect the worktree, branch, remotes, latest public `v*` tag, and the complete committed and uncommitted diff since that tag. Read the user-visible changes rather than inferring scope from recent commits alone.

Stop when the candidate cannot be separated from unrelated changes, the intended release is not a safe fast-forward of `origin/main`, or the target remote is ambiguous. For a new release, also stop if the requested version already exists as a tag or GitHub Release. When resuming an interrupted publication, reconcile the existing state with the exact candidate under [publishing.md](references/publishing.md) before changing release files or rerunning preparation.

Choose the version with [versioning.md](references/versioning.md). A release request authorizes the computed calendar number without separate confirmation.

## Prepare

Update these release-owned surfaces together:

- `CHANGELOG.md`, with concise outcome-level notes covering the complete tag-to-candidate diff and explicit compatibility or breaking changes;
- `package.json` and both root entries in `package-lock.json` with the calendar version;
- `static/manifest.json` with the same calendar version;
- release instructions when the actual preparation or publication contract changed.

Preserve upstream changelog history and identify its ownership boundary instead of renumbering or rewriting it. Do not include generated bundles, local runtime state, proprietary assets, tokens, personal paths, or unsupported validation claims in Git.

Run the complete gate in [checks.md](references/checks.md). Preparation is complete only when the version fields agree, the notes cover the candidate, the output directory contains the expected audited artifacts and checksums, and every required local check passes.

## Publish

Read [publishing.md](references/publishing.md) because order and recovery are correctness properties for externally visible release state. Publication is complete only when GitHub shows the release for the exact candidate commit and every expected asset is downloadable with the recorded checksum.

If any external step fails after `main`, a tag, or a draft release changes, stop and report the exact durable state plus the safe resume point. Do not manufacture success or repair it by deleting or moving the tag.

## Done

Report the version, artifact names and checksum file, exact validation outcomes, and separate automated, live-app, and physical-device evidence. For Publish, also report the released commit, tag and release URL. Label unavailable evidence as not run or user-reported rather than upgrading it to a stronger kind of validation.
