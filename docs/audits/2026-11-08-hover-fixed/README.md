# Fixed hover cover

The hover feature now uses only the built-in work notes page. Settings retain the
hover toggle (off for new installations); no URL input, external website loader,
display capability route, dynamic resource policy or fallback remains. The former
custom URL implementation and its obsolete fixtures and audit artifacts were
removed. Historical implementation remains available in Git history.

Database schema version 2 removes only the two retired cover settings. The
migration preserves the hover choice, all other preferences and watch progress.
Tests exercise reopening twice and reject retired fields at the service boundary.
Published resource aliases through v19 remain; the abandoned experimental dynamic
resources are removed. Current resources use v22 to invalidate cached UI.

Validation:

- `npm test`: 165 tests, 159 passed, 6 Windows-only tests skipped, no failures.
- `npm run package` and `npm run verify:install`: passed. Installation validation
  uses a disposable profile, including real Codex host protocol checks, repeated
  installation and uninstall checks. It does not verify native video playback.
- The Codex in-app browser loaded the production HTTP player with synthetic media.
  Settings had zero URL inputs and the player contained zero website iframes.
  Playback advanced; leaving the panel showed work notes and froze playback at
  19.338481 seconds; returning resumed playback and its progress advanced.
  See [browser-check.json](browser-check.json), [settings](settings.jpg) and
  [fixed cover](fixed-cover.jpg).
- The user's local plugin was updated from this branch's offline package. Installed
  HTML, server, setup check and hooks match the candidate. Old stored cover fields
  are absent; other preferences and watch progress are unchanged; the existing
  hover toggle remains enabled. Only boolean verification results were recorded
  in [local-install.json](local-install.json).

The Codex native main-window panel has not been validated in this check. Existing
panels and MCP processes can retain old UI or server code until Codex restarts.
Restart Codex and reopen the Hongguo panel for manual acceptance of this build.
