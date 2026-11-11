# openhongguo playback signing patch

This distribution builds openhongguo 0.2.0 with the unmerged playback signing
change from kadaliao, submitted as beilunyang/openhongguo pull request #7.
The exact reviewed commit and matching source archive hash are in source.json.
The source archive contains the complete preferred source and upstream tests.

Upstream project: https://github.com/beilunyang/openhongguo
Patch: https://github.com/beilunyang/openhongguo/pull/7
Revision: bed14595d35b02e0d550270621812ca7386c4108
License: Apache-2.0 (LICENSE). The Go runtime retains its BSD license (GO_LICENSE).

The patch adds the Argus/Ladon playback signer and its tests and changes
sdk/media.go to call that signer. Other SDK API signing remains unchanged.
This is an experimental pinned build, not a new upstream release. The patch
author declares an independent implementation; that provenance claim has not
been independently established by this project. No third-party signing service
or account login is added. See the pull request for its references and discussion.

Build: node scripts/build-openhongguo.mjs
The script verifies the bundled archive hash, extracts it into an isolated
temporary directory, compiles the Go WebAssembly binding, and copies the Node
wrapper and the matching Go runtime into dist/vendor/openhongguo.
