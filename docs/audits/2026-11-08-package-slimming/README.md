# Exclude README screenshots from installation

The npm archive and both locations in the offline ZIP no longer contain README
screenshots. Consumer guides link to the screenshots under the matching version
tag on raw.githubusercontent.com. The repository's Chinese and English READMEs
use relative links to the compressed assets.

Both PNG screenshots were converted with ImageMagick to lossless WebP using
`webp:lossless=true`, `webp:exact=true`, and `webp:method=6`. No resize, palette
quantization, or lossy quality setting was applied. Decoding the originals and
the results to 8-bit RGBA produced identical SHA-256 values; dimensions also
match. The original PNGs remain recoverable from tag v0.0.35-beta.5.

| Content | Before (bytes) | After (bytes) |
| --- | ---: | ---: |
| Catalog screenshot | 5,044,124 | 2,743,180 |
| Player screenshot | 4,770,214 | 2,603,448 |
| npm archive | 13,883,015 | 4,222,364 |
| Offline ZIP | 23,842,060 | 4,524,657 |

Validation: the local regression suite passed (211 tests, 205 passed and six
Windows-only skips). Both archive formats were inspected: screenshots are absent
and all four offline consumer guides plus both npm guides retain two remote WebP
links pinned to v0.0.35-beta.6. Native installation verification also checks the
installed directory and both consumer guides, so the release qualification gates
enforce this on macOS, Linux, and Windows.

See [images.json](images.json) and [archives.json](archives.json). FFmpeg and the
player implementation were not changed in this iteration.
