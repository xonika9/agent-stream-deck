# Version selection

Releases use calendar versions `YY.M.D.N`: the release date in `Europe/Moscow`, followed by a positive release number that starts at 1 each day. Month and day have no leading zeros because Stream Deck rejects them in manifest versions; for example `26.11.3.1`. Compatibility does not determine the number.

After fetching public tags, `npm run release:prepare -- --next-version` prints the next number. Use it unchanged in `package.json`, both root entries of `package-lock.json`, `static/manifest.json`, the changelog heading, the `v`-prefixed tag, and artifact names. Describe incompatible changes and required migration under explicit compatibility or breaking-change notes instead of encoding them in the number.

Historical SemVer releases through `v2.2.2` keep their numbers; never renumber them. For a new release, before editing release files, verify that neither `refs/tags/vYY.M.D.N` nor a GitHub Release for that version exists. Released versions are immutable. For an interrupted publication, follow [publishing.md](publishing.md) and retain the existing candidate and version.
