// Local anonymous UI qualification, using only a disposable qualification DB.
import { randomBytes } from 'node:crypto'
import { basename } from 'node:path'
import { Store } from '../src/server/store.mjs'
import { Catalog } from '../src/server/catalog.mjs'
import { Service, secret } from '../src/server/service.mjs'
import { BrowserServer } from '../src/server/browser.mjs'
import { ProviderRegistry, builtins } from '../src/server/providers/registry.mjs'
import { BilibiliSource } from '../src/server/sources/bilibili.mjs'

const root = process.argv[2]
if (!root || !basename(root).startsWith('bilibili-qualification-')) throw Error('A disposable Bilibili qualification directory is required')
const store = new Store(root)
store.setPreferences({ enabledProviders: ['hongguo', 'bilibili'], defaultSource: 'bilibili', defaultMuted: true })
const sources = new ProviderRegistry(root, { enabled: ['hongguo', 'bilibili'], builtins: [builtins[0],
  { manifest: builtins[1].manifest, createProvider: ctx => new BilibiliSource(ctx, { cookie: '' }) }] })
await sources.ready
const catalog = new Catalog(store, { sources }), service = new Service(store, catalog)
const session = 'bilibili-ui-review', turn = 'review-' + Date.now()
store.event({ session_id: session, turn_id: turn, hook_event_name: 'UserPromptSubmit' })
const scope = service.panel(service.open({ threadId: session }).panel)
scope.source = 'bilibili'
const progress = store.history(undefined, undefined, 30, 'bilibili')[0]
scope.selection = progress && { seriesId: progress.seriesId, episodeId: progress.episodeId,
  title: progress.title, label: progress.label }
class ReviewServer extends BrowserServer {
  async request(req, res) {
    if (req.url === '/' && req.method === 'GET') {
      // Transfer a disposable HttpOnly session directly to the browser. Never
      // put pairing tickets, Cookie values or account data in a tool result.
      const id = randomBytes(12).toString('hex'), key = secret(), path = '/p/' + id + '/'
      this.sessions.set(id, { ...scope, key, grants: new Set(), expires: Date.now() + 3600000 })
      res.writeHead(302, { Location: path, 'Set-Cookie': 'hg=' + key + '; Path=' + path + '; HttpOnly; SameSite=Strict' })
      res.end(); return
    }
    if (req.url === '/qualification/stop' && req.method === 'POST' && req.headers.origin === this.origin) {
      store.event({ session_id: session, turn_id: turn, hook_event_name: 'Stop' })
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"stopped":true}'); return
    }
    return super.request(req, res)
  }
}
const server = new ReviewServer(service)
await server.listen()
console.log(JSON.stringify({ reviewOrigin: server.origin, authentication: 'anonymous', userPluginChanged: false }))
async function close() { server.server.closeAllConnections(); server.server.close(); await sources.dispose(); store.close(); process.exit() }
process.once('SIGINT', close); process.once('SIGTERM', close)
