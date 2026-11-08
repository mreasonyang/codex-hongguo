# Allow slower playback-component downloads

The total download budget is 30 minutes rather than five. Up to three attempts
share that budget. A timed-out download now has the fixed `download-timeout`
category and a message naming the 30-minute limit; raw network errors and signed
download URLs are not exposed. Partial archives still cannot be installed, and
the existing archive and executable integrity checks remain in effect.

Concurrent installers can wait 32 minutes. The owner refreshes its lock every
30 seconds, including for compatibility with older versions that consider a
ten-minute-old lock abandoned. Abandoned-lock recovery retains the ten-minute
threshold. Outstanding refreshes finish before cleanup. The `doctor` subprocess
allows 64 minutes to cover lock waiting, its own download and preparation.

Validation:

- The complete local regression suite passed: 214 tests, 208 passed, six
  Windows-only skips, no failures.
- Virtual-clock tests show that a download can complete after six minutes, that
  the exact 30-minute boundary aborts without installing partial bytes, and that
  timeout errors reveal only the fixed reason. These tests do not wait in real
  time or infer the user's actual network failure from the generic error.
- A virtual eleven-minute transfer keeps the installation lock fresh and removes
  it when finished. Existing independent-process, retry, cache and hash tests pass.
- `npm run package` and `npm run verify:install` passed for beta.7, including a
  fresh disposable Codex profile, native npm installation, component preparation,
  host discovery and persistence checks.
- The beta package must additionally pass the release workflow's same-artifact
  macOS, Linux and Windows regression and native npm installation gates.

The component archive, download origins and retry count are unchanged. This
change increases the total transfer budget; it does not add resumable downloads.
