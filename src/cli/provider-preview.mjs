import { Store } from '../server/store.mjs'
import { Catalog } from '../server/catalog.mjs'
import { Service } from '../server/service.mjs'
import { BrowserServer } from '../server/browser.mjs'
import { ProviderRegistry, builtins } from '../server/providers/registry.mjs'
import { readPackage } from '../server/providers/package.mjs'

export async function previewProvider({ root, directory }) {
  const plugin = await readPackage(directory)
  const sources = new ProviderRegistry(root, { directory: '', builtins: [builtins[0]] })
  await sources.ready
  await sources.register(plugin.manifest, plugin.factory)
  sources.get(plugin.manifest.id)
  const store = new Store(root), catalog = new Catalog(store, { sources })
  const service = new Service(store, catalog)
  // Preview uses a disposable host. Keep pairing tickets inside the HTTP
  // exchange and reject foreign Host headers before creating a ticket.
  class PreviewServer extends BrowserServer {
    async request(req, res) {
      if (req.url !== '/' || req.method !== 'GET') return super.request(req, res)
      if (req.headers.host !== new URL(this.origin).host || req.headers['sec-fetch-site'] === 'cross-site') {
        res.writeHead(403); res.end(); return
      }
      const source = plugin.manifest.nsfw ? 'hongguo' : plugin.manifest.id
      this.prune()
      const url = this.sessionPage({ sessionId: null, source }, res)
      res.writeHead(302, { Location: url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }); res.end()
    }
  }
  const server = new PreviewServer(service)
  await server.listen()
  return { origin: server.origin, close: async () => { server.close(); catalog.panelMedia?.close(); await sources.dispose(); store.close() } }
}
