# Managed FFmpeg playback component

The plugin's project code is AGPL-3.0-only licensed. FFmpeg is a separate executable,
automatically downloaded into the user's private cache. macOS components are
built by this project from pinned official FFmpeg and VideoLAN x264 sources.
Windows/Linux components are compact
repackages of the same pinned upstream executables. The npm package does not
contain the FFmpeg executable.

The selected builds enable GPL components (including libx264). FFmpeg and those
components retain their own licenses; see COPYING.GPLv3 and the distributors'
source, build configuration and licensing information:

- FFmpeg 9.0.2: https://github.com/FFmpeg/FFmpeg/tree/n9.0.2
- macOS source pins: macos-build.json
- macOS builds and complete source archives: https://github.com/mreasonyang/codex-hongguo/releases/tag/ffmpeg-macos-9.0.2-r1
- Linux/Windows: https://github.com/BtbN/FFmpeg-Builds/tree/master/scripts.d
- Pinned Linux/Windows build: https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-10-31-12-59
- FFmpeg source commit for that build: https://github.com/FFmpeg/FFmpeg/tree/7adfbe40dc

Exact archive URLs, sizes and SHA-256 hashes are in ffmpeg-artifacts.json.
The macOS source build targets macOS 12.0 or later. x264 is linked statically;
only macOS system libraries/frameworks may remain dynamically linked. The build
enables native H.264/HEVC/AAC decoding, libx264 software encoding, VideoToolbox
hardware encoding and AudioToolbox. It disables network protocols and automatic
detection of optional third-party libraries. The plugin downloads media itself
and supplies local files to FFmpeg. libx265 encoding is not included; HEVC decoding
and conversion to H.264 are included and exercised on both architectures.

The macOS release carries the exact source tarballs, source hashes, build recipe,
configuration, toolchain information and native test receipts. The executable's
ad-hoc signature checks integrity only; it is not a developer identity or an
Apple notarization claim. This component uses a new cache identity and leaves
previous cached components intact until plugin uninstall.
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
