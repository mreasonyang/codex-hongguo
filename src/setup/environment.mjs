import { Store } from '../server/store.mjs'
import { manualHooks } from '../server/setup.mjs'
import { ensureFfmpeg } from '../runtime/ffmpeg-runtime.mjs'

export async function checkEnvironment(host) {
  let database = false, store
  try { store = new Store(undefined, false, { host }); database = store.writable() } catch { /* Report only readiness. */ }
  finally { store?.close() }
  const [major, minor] = process.versions.node.split('.').map(Number)
  const runtime = { version: process.version, ready: major > 22 || (major === 22 && minor >= 16) }
  let media = false
  try { await ensureFfmpeg({ host }); media = true } catch { /* Report readiness without raw download or process diagnostics. */ }
  const hooks = manualHooks(host)
  const manualReady = runtime.ready && database && media
  return { runtime, database, ffmpeg: media, hooks, manualReady }
}
