import { spawnSync } from 'node:child_process'
import { Store } from '../server/store.mjs'
import { inspectHooks } from '../server/setup.mjs'
import { findExecutable } from '../runtime/executables.mjs'

const ffmpeg = findExecutable('ffmpeg', process.env.HONGGUO_FFMPEG)
const codex = findExecutable('codex', process.env.HONGGUO_CODEX)
let database = false, store
try { store = new Store(); database = store.writable() } catch { /* Report only readiness. */ }
finally { store?.close() }
const [major, minor] = process.versions.node.split('.').map(Number)
const runtime = { version: process.version, ready: major > 22 || (major === 22 && minor >= 16) }
const media = spawnSync(ffmpeg, ['-version'], { stdio: 'ignore', timeout: 2500, windowsHide: true }).status === 0
const hooks = await inspectHooks({ command: codex })
const manualReady = runtime.ready && database && media
console.log(JSON.stringify({ runtime, database, ffmpeg: media, hooks, manualReady, followReady: manualReady && hooks.status === 'ready' }, null, 2))
