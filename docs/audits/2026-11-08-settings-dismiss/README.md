# Consistent Settings dismissal

Settings closes after Close, its toolbar toggle, a click on player content outside
Settings, or Escape. Each path waits for successful persistence. Invalid keywords
and failed saves keep Settings open and retain desired values for retry. The
first outside click is consumed so it cannot also start playback, navigate, or
activate another player control. Clicks inside Settings or on its toggle are not
intercepted. Escape during IME composition is left to the input method.

Moving the pointer out of the panel never closes Settings. With hover cover on,
the cover temporarily conceals the complete player and Settings; returning
restores the same open form. With hover cover off, the form remains visible.
Covered/inert content ignores dismissal input. No main-player controls were added.
UI resource v25 also serves the prior v24 URI for existing conversations.

Validation before beta publication:

- `npm test`: 211 tests, 205 passed, 6 Windows-only tests skipped, no failures.
  This includes pending saves, failed-save retry, invalid keywords, both hover
  settings, input-method Escape, outside-click scope, and hover leave/return.
- Production HTTP UI in the Codex in-app browser passed 12 interaction checks.
  Real browser events confirmed outside clicks did not activate Play, Escape
  closed Settings, invalid input and failed saves kept it open, and a successful
  retry persisted keywords. A cross-origin iframe and a synthetic chat area
  confirmed pointer exit/return preserves Settings with hover on and off.
- All browser data and save-failure controls belonged to the isolated fixture;
  the user's database and provider services were not used for these checks.
- The UI checks used the beta.4 build. Its release was blocked because the
  installation verifier still expected resource v24. The verifier was corrected
  to v25; beta.5 has the same UI implementation. `npm run package` and
  `npm run verify:install` then passed locally for beta.5, including a disposable
  Codex profile, native npm installation, host resource checks, and data retention.

See [browser-check.json](browser-check.json) and [Settings after leaving the
panel with hover off](settings-open.png). These checks do not establish native
Codex main-window playback acceptance. The tagged beta must additionally pass
same-artifact regression and isolated installation checks on macOS, Linux, and
Windows before the release workflow uploads it to npm.
