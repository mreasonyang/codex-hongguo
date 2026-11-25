# openhongguo upstream source

This distribution builds unmodified source from the official openhongguo
repository at the exact release commit recorded in source.json. The bundled
archive contains the SDK source and upstream tests from the verified GitHub
source. The standalone signer service and its bundled binary are omitted.

Upstream project: https://github.com/beilunyang/openhongguo
Revision and release URL: see the accompanying source.json.
License: Apache-2.0 (LICENSE). The Go runtime retains its BSD license (GO_LICENSE).

The SDK uses the upstream built-in signer and includes the V5 playback fixes
released in v0.3.1. The Node binding and its package metadata are copied from
the upstream build. source.json and the shipped SOURCE.json identify the exact
source commit and the checksum of the original GitHub archive.

Build: node scripts/build-openhongguo.mjs
The script downloads the official archive by its fixed commit, verifies its
SHA-256 hash and caches it under node_modules/.cache/. It extracts the verified
archive into an isolated temporary directory, invokes the upstream Node
binding build, and copies the Go WebAssembly binding, Node wrapper and matching
Go runtime into dist/vendor/openhongguo. The distribution source attachment
at licenses/openhongguo/source.tar.gz is packed from the verified source before
the build, with the signer/ directory excluded.
