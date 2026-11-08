# Compact Windows and Linux playback components

The independent component release is
[ffmpeg-9.0.2-20261031-r1](https://github.com/mreasonyang/codex-hongguo/releases/tag/ffmpeg-9.0.2-20261031-r1).
It was built and qualified by
[component CI](https://github.com/mreasonyang/codex-hongguo/actions/runs/42463907453).
All four complete upstream archives matched their fixed SHA-256 pins before
extraction. The selected executable is a regular file of the expected platform
and CPU architecture. Repackaged archives round-trip to exactly the same binary
SHA-256 and byte size. No codec or acceleration build options were changed.

| Platform | Original download (bytes) | Compact download (bytes) |
| --- | ---: | ---: |
| Windows x64 | 195,110,184 | 64,054,522 |
| Windows ARM64 | 136,603,040 | 44,629,873 |
| Linux x64 | 153,175,100 | 49,975,964 |
| Linux ARM64 | 128,664,064 | 42,121,616 |

Each compact archive contains only the executable, license notices, source
access directions and provenance. The release also provides a pinned FFmpeg
source snapshot, exact upstream build recipes/patches, dependency source-reference
index and qualification metadata. These optional source assets are not downloaded
by the installer. Components remain separate from the npm package.

Native Windows x64 and Linux x64 tests passed H.264/AAC encode/decode, HEVC to
H.264 conversion, JPEG cover generation and framehash codec inspection. ARM64
validation covers the full source-archive hash, executable architecture and exact
binary identity; native ARM64 playback was not exercised in this component run.

The runtime retains the original cache directory through a bounded `cacheKey`.
Reusing a receipt from another archive requires this plugin's owner/schema and
the pinned binary hash; the actual file is checked before execution. In-memory
verification also includes the expected executable identity. Original receipts
remain unchanged so they continue to describe the archive actually used.
Corrupt or different binaries cannot reuse a verification result or avoid repair.

Local validation: 220 regression tests, 213 passed, seven platform-specific
skips. Local packaging and a fresh isolated native npm installation also passed.
Five archive/repacking unit tests passed. Additional runtime cases cover
legacy receipt reuse after a process restart, pinned-identity changes, corruption,
receipt ownership and invalid cache keys. Native Windows/Linux CI additionally
copies the real component into a legacy cache and verifies reuse with network
access forbidden. The beta release must pass full same-artifact three-platform
regression and native npm installation before publication.

See [components.json](components.json) and [qualification.json](qualification.json).
These checks do not establish Codex main-window playback acceptance. The npm
stable channel and stable marketplace are not advanced by this beta work.
