# Randomized local cover pages

The hover cover now chooses among project tasks, technical notes, test reports and
meeting notes. Each page varies its project name, content, item counts, spacing,
sidebar presence and document width. The tasks page can use two or three lanes;
technical notes vary sections and their table of contents. The date is formatted
in the interface language when the page is generated.

One mounted player retains its page across pointer exits and returns, playback,
episode selection, preference polling and settings saves. Only closing and opening
a new panel, or clicking **Change page** in Settings, creates a new page. An
explicit change always picks a different template and takes effect without saving
settings. It changes only this panel and does not change playback or preferences.

The templates are local DOM content with Chinese and English copy and existing
theme tokens. They perform no network requests, load no websites, save no generated
page settings and add no fallback. The existing hover switch remains off for new
installations. The retired URL fields remain removed.

Validation:

- `npm test`: 175 tests, 169 passed, 6 Windows-only tests skipped, no failures.
  Coverage includes all templates in both languages, independent openings,
  within-panel stability, explicit replacement, consistent report totals, settings
  preservation and playback preservation. Existing hover/task lifecycle checks pass.
- `npm run package` and `npm run verify:install`: passed, including disposable
  installation/reinstallation, Codex host protocol checks, and disposable uninstall.
- The Codex in-app browser loaded production HTTP UI with synthetic media. All four
  templates were inspected in English and Chinese. At 1280 and 360 CSS pixels, the
  cover's scroll width equalled its client width. Dark appearance was checked.
  Page content stayed unchanged across hover/appearance changes; covering paused
  at 80.084642 seconds and held that position; returning resumed and advanced.
  An explicit page change also left playback running. See
  [browser-check.json](browser-check.json), [Chinese settings](settings-zh.jpg),
  [tasks](tasks-zh.jpg), [technical notes](document-zh.jpg),
  [test report](report-zh.jpg) and [meeting notes](minutes-zh.jpg).
- The local plugin was refreshed from this branch's offline package. Candidate and
  installed UI, server, setup check and hooks match. Existing settings and watch
  progress are preserved, and the user's hover toggle remains enabled. Only boolean
  checks are saved in [local-install.json](local-install.json).

This is browser and protocol evidence, not native Codex main-window playback
acceptance. Restart Codex and reopen Hongguo before manual testing so the previous
panel and MCP process do not retain older UI or server code. Current resources use
v23 to invalidate the cached UI. No public release or push was performed.
