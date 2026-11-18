import { Store } from '../server/store.mjs'
import { manualHooks } from '../server/setup.mjs'
import { ensureFfmpeg } from '../runtime/ffmpeg-runtime.mjs'

export async function checkEnvironment(host) {
  let database = false, store, hookActivity = null
  try {
    store = new Store(undefined, false, { host })
    database = store.writable()
    if (host.id === 'antigravity') {
      hookActivity = store.db.prepare(`SELECT max(submitted_at) AS lastStartAt,
        max(CASE WHEN stopped = 1 OR interrupted = 1 THEN observed_at END) AS lastEndAt FROM turn_state`).get()
    }
  } catch { /* Report only readiness and aggregate activity. */ }
  finally { store?.close() }
  const [major, minor] = process.versions.node.split('.').map(Number)
  const runtime = { version: process.version, ready: major > 22 || (major === 22 && minor >= 16) }
  let media = false
  try { await ensureFfmpeg({ host }); media = true } catch { /* Report readiness without raw download or process diagnostics. */ }
  const hooks = manualHooks(host)
  const manualReady = runtime.ready && database && media
  return { runtime, database, ffmpeg: media, hooks, manualReady,
    ...(host.id === 'antigravity' ? { hookActivity } : {}) }
}
