# Veyra Huangguo module

Source: https://github.com/gybeyond1/Veyra
Revision: a83dfd9a29b23d439da4f853d104568696cd401c
Path: server/sources/huangguoai.js
Upstream Git blob: f7e0dbc11fca7c554919ebffdd4919940eabd8be
License: GNU General Public License version 3; complete text in LICENSE.

Veyra credits its derivation from MrSsg/HuangguoAPP-for-Andriod (GPL-3.0).
The original file has no individual copyright notice; upstream notices and
license are retained here. Attribution belongs to the Veyra contributors
and their upstream contributors.

The adapted module is src/server/sources/vendor/veyra-huangguo.mjs.
Local changes:
- ESM factory with an injected request function instead of Veyra's HTTP utility.
- Mirror selection state is owned by each client instance.
- Cancellation, rate limits and authorization/content failures do not retry
  across mirrors.
- List/search methods accept the host page size instead of fixing it to 24/20.
- Playback follows the site's 2026-11-10 POST episodes/<n>/playback endpoint
  and streams.main/hevc fields; the legacy GET /play endpoint returns empty
  URLs. Preview-only responses and unsupported manifest methods are rejected.
The site models and JSON API/playback mapping remain derived from Veyra.

Cover decoding in src/server/sources/vendor/veyra-cover.mjs is adapted from
desktop/src/main/huangguo.ts at the same revision (Git blob
b7b410c69d3102b047d6ff3f7a5b243b4cfaeb73). Local changes add WebP/AVIF/HEIC
recognition and remove valid PKCS7 padding. Site PNG-header repair is retained.

The adapter in src/server/sources/huangguo.mjs supplies bounded anonymous
transport, namespaced identifiers, pagination, cover decoding and HLS playback.
Its host transports retain TLS verification and never load Veyra account data,
server setup, proxy credentials or installers.

Distribution includes this notice, the GPLv3 text and matching preferred-form
source/build inputs in licenses/codex-hongguo-source.zip. The parent project
remains AGPL-3.0-only; GPLv3 section 13 and AGPLv3 section 13 allow combination.
Veyra-derived code retains GPLv3 and the AGPLv3 network interaction obligations
apply to the combined program.
