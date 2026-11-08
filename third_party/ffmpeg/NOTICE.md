# Managed FFmpeg playback component

The plugin's project code is AGPL-3.0-only licensed. FFmpeg is a separate executable,
automatically downloaded from the original binary distributors into the user's
private cache. The npm package does not contain the FFmpeg executable.

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
The BtbN month-end build is retained upstream for two years. Maintainers must
refresh and verify the manifest before that retention period expires.

Archives are verified before extracting the named executable. Cached binaries
are checked against their hash before reuse. Downloads never modify system
package managers, PATH configuration, signing settings or Hook trust records.
