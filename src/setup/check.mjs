import { Store } from '../server/store.mjs'
import { manualHooks } from '../server/setup.mjs'
import { ensureFfmpeg } from '../runtime/ffmpeg-runtime.mjs'

let database = false, store
try { store = new Store(); database = store.writable() } catch { /* Report only readiness. */ }
finally { store?.close() }
const [major, minor] = process.versions.node.split('.').map(Number)
const runtime = { version: process.version, ready: major > 22 || (major === 22 && minor >= 16) }
let media = false
try { await ensureFfmpeg(); media = true } catch { /* Report readiness without raw download or process diagnostics. */ }
const hooks = manualHooks()
const manualReady = runtime.ready && database && media
console.log(JSON.stringify({ runtime, database, ffmpeg: media, hooks, manualReady }, null, 2))
