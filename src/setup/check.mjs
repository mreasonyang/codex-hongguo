import { Store } from '../server/store.mjs'
import { inspectHooks } from '../server/setup.mjs'
import { findExecutable } from '../runtime/executables.mjs'
import { ensureFfmpeg } from '../runtime/ffmpeg-runtime.mjs'

const codex = findExecutable('codex', process.env.HONGGUO_CODEX)
let database = false, store
try { store = new Store(); database = store.writable() } catch { /* Report only readiness. */ }
finally { store?.close() }
const [major, minor] = process.versions.node.split('.').map(Number)
const runtime = { version: process.version, ready: major > 22 || (major === 22 && minor >= 16) }
let media = false
try { await ensureFfmpeg(); media = true } catch { /* Report readiness without raw download or process diagnostics. */ }
const hooks = await inspectHooks({ command: codex })
const manualReady = runtime.ready && database && media
console.log(JSON.stringify({ runtime, database, ffmpeg: media, hooks, manualReady, followReady: manualReady && hooks.status === 'ready' }, null, 2))
