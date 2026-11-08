# Managed FFmpeg playback component

The plugin's original code is MIT licensed. FFmpeg is a separate executable,
automatically downloaded into the user's private cache. macOS components come
from the original binary distributors. Windows/Linux components are compact
repackages of the same pinned upstream executables. The npm package does not
contain the FFmpeg executable.

The selected builds enable GPL components (including libx264). FFmpeg and those
components retain their own licenses; see COPYING.GPLv3 and the distributors'
source, build configuration and licensing information:

- FFmpeg 9.0.2: https://github.com/FFmpeg/FFmpeg/tree/n9.0.2
- macOS Apple Silicon: https://www.osxexperts.net/
- macOS Intel: https://evermeet.cx/ffmpeg/ and https://evermeet.cx/ffmpeg/info/ffmpeg/9.0.2
- Linux/Windows: https://github.com/BtbN/FFmpeg-Builds/tree/master/scripts.d
- Pinned Linux/Windows build: https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-10-31-12-59
- FFmpeg source commit for that build: https://github.com/FFmpeg/FFmpeg/tree/7adfbe40dc

Exact archive URLs, sizes and SHA-256 hashes are in ffmpeg-artifacts.json.
The original Windows/Linux archive pins are retained in upstream-artifacts.json.
The compact archives contain the unchanged executable, upstream license notices,
GPLv3 text and provenance. Binary hashes are checked before and after repacking;
no compiler, codec or hardware-acceleration options have been changed.

Compact component release and complete source access directions:
https://github.com/mreasonyang/codex-hongguo/releases/tag/ffmpeg-9.0.2-20261031-r1

The release includes a pinned FFmpeg source snapshot, the exact upstream build
recipes and dependency patches, a dependency source-reference index, GPLv3 text,
and qualification receipts. SOURCE.md alongside the binary assets and inside
every compact archive describes source access. Maintainers must preserve source
availability when retaining or updating these redistributed components.

The BtbN month-end build is retained upstream for two years. Maintainers must
refresh and verify upstream pins before that retention period expires. Compact
component assets and their source-access files are retained independently.

Archives are verified before extracting the named executable. Cached binaries
are checked against their hash before reuse. Downloads never modify system
package managers, PATH configuration, signing settings or Hook trust records.
