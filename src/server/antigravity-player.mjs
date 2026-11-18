import { SidecarApp, Response } from 'sidecar_sdk'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { antigravity } from '../runtime/host.mjs'
import { registerFfmpegHost } from '../runtime/ffmpeg-runtime.mjs'
import { Store, validId } from './store.mjs'
import { Catalog } from './catalog.mjs'
import { Service, schemas } from './service.mjs'
import { projectRoot } from './paths.mjs'
import { PlayerError, message } from './errors.mjs'
import { recordSidecarReady } from './antigravity-sidecar.mjs'

// Sidecar SDK authenticates POST requests with this host-issued token.
if (!process.env.ANTIGRAVITY_SIDECAR_UI_TOKEN) throw Error('Antigravity 播放器需要宿主授权。')
process.umask(0o077)
const store = new Store(undefined, false, { host: antigravity })
const catalog = new Catalog(store, { prepareRuntime: registerFfmpegHost })
const service = new Service(store, catalog)
await catalog.sources.ready

const app = new SidecarApp()
const html = readFileSync(join(projectRoot, 'dist/ui/player.html'), 'utf8')
  .replace('data-host="panel"', 'data-host="sidecar"')
  .replace('</head>', '<script src="/preload.js"></script></head>')
app.page('/', () => {
  const nonce = randomBytes(16).toString('base64')
  return new Response(html.replace('__NONCE__', nonce), { contentType: 'text/html; charset=utf-8', headers: {
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': `default-src 'none'; script-src 'self' 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src data: blob:; media-src blob:; worker-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'`,
  } })
})

function conversation(conversationId) {
  // The pane receives the conversation ID from Antigravity's preload. Without
  // a conversation (e.g. a global view), allow playback without a turn link.
  if (conversationId === null) return {}
  if (!validId(conversationId) || conversationId.length > 120) throw new PlayerError('会话不匹配', 403)
  return { threadId: conversationId }
}
function route(path, respond) {
  app.api(path, async data => {
    try { return await respond(data) } catch (error) {
      return new Response(JSON.stringify({ error: message(error) }), {
        contentType: 'application/json', status: error instanceof PlayerError ? error.status : 500,
      })
    }
  })
}
route('/api/context', ({ conversationId }) => service.open(conversation(conversationId)))
route('/api/call', ({ conversationId, panel, name, args }) => {
  if (typeof name !== 'string' || !Object.hasOwn(schemas, name) ||
      ['create_browser_pairing', 'list_sessions', 'select_session'].includes(name)) throw new PlayerError('请求参数无效')
  const meta = conversation(conversationId)
  const scope = service.panel(panel, meta)
  if (scope.caller !== service.caller(meta)) throw new PlayerError('会话不匹配', 403)
  // Antigravity preloads and retains the pane's webview while the pane is
  // closed. Its document visibility cannot suppress chat recommendations.
  if (name === 'set_player_visible') return {}
  if (name === 'get_run_state') return service.call(scope, name, { ...args, playerInstance: undefined })
  return service.call(scope, name, args)
})

await app.run()
recordSidecarReady(store)
const heartbeat = setInterval(() => {
  try { recordSidecarReady(store) } catch { /* Retry after SQLite contention. */ }
}, 10000)
heartbeat.unref()
