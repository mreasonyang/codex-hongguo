# Settings save automatically

The main player gains no controls. Settings switches now save individual patches
automatically. Recommendation keywords save on Enter or blur; typing alone does
not save. The footer contains only Close. Close, the settings toggle and Change
page all wait for pending saves; Change page then replaces this panel's cover and
closes Settings. Invalid keywords or a failed save keep Settings open and leave
the cover unchanged. Failed values remain available for retry.

Writes are serialized, and obsolete values still waiting in the queue are
coalesced. Poll replies captured before a setting change cannot overwrite its
newer saved value. An untouched keyword field does not overwrite changes received
from another chat. Closing the player invalidates late UI callbacks.

Validation:

- `npm test`: 188 tests, 182 passed, 6 Windows-only tests skipped, no failures.
  Tests include rapid changes, pending saves, failure/retry, duplicate close/change
  clicks, keyword validation, Enter/blur/IME behavior, cross-chat changes, stale
  polling, manual mute preservation and player teardown.
- `npm run package` and `npm run verify:install`: passed, including disposable
  installation and Codex host protocol checks. No public package was published.
- The Codex in-app browser used production HTTP UI with synthetic media. English
  switches and Enter saves applied without closing Settings. Change page replaced
  the cover and closed Settings while playback continued. Empty keywords blocked
  both closing and replacement. Chinese blur saves and persistence after reload
  were checked. Settings contains no submit/save button.
- A test-only control server rejected settings writes. The production UI retained
  the settings panel and cover and displayed a localized error. Restoring saves and
  clicking Change page persisted the pending switch, changed the cover and closed
  Settings; media remained playing and advanced. These controls are confined to
  `scripts/verify-hover-decoy-ui.mjs` and are absent from the shipped plugin.
- The user's local installation was refreshed, and its UI, server, setup checker
  and hooks match the candidate. Existing preferences, enabled hover choice and
  watch progress were preserved. See [local-install.json](local-install.json).

See [browser-check.json](browser-check.json), [Settings](settings-zh.jpg),
[saved state](saved-zh.jpg) and [save failure](save-error-zh.jpg). Browser and host
protocol evidence does not establish native Codex main-window playback acceptance.
Restart Codex and reopen Hongguo for manual testing of resource version v24.
