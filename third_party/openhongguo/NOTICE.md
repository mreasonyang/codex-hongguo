# openhongguo upstream source

This distribution builds unmodified source from the official openhongguo
repository at the exact upstream commit recorded in source.json. The bundled
archive is the official GitHub source archive, verified by its SHA-256 hash.
It contains the complete preferred source and upstream tests.

Upstream project: https://github.com/beilunyang/openhongguo
Revision: 4bc88830eba186c13caf36cc915ace38785e2f8e
Merged playback fix: https://github.com/beilunyang/openhongguo/pull/7
License: Apache-2.0 (LICENSE). The Go runtime retains its BSD license (GO_LICENSE).

The upstream commit includes the Argus/Ladon playback signer. No local SDK
patches are applied. The upstream npm release is still 0.2.0 at the time of
this integration and does not include that merged fix. The upstream binding's
package.json is preserved unchanged, including version 0.2.0. source.json and
the shipped SOURCE.json identify the exact source commit; this is not a new
upstream npm release.

Build: node scripts/build-openhongguo.mjs
The script downloads the official archive by its fixed commit, verifies its
SHA-256 hash and caches it under ignored dist/licenses/. No upstream source
archive is committed to this repository. It extracts the verified archive into
an isolated temporary directory, invokes the upstream Node binding build, and
copies the Go WebAssembly binding, Node wrapper and matching Go runtime into
dist/vendor/openhongguo. Packaging places the archive at
licenses/openhongguo/source.tar.gz as a distribution source attachment.
