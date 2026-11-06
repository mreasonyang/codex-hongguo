import { Store } from '../../src/server/store.mjs'
import { SharedCatalogCache } from '../../src/server/catalog-cache.mjs'

let store, cache, finish
process.on('message', async message => {
  if (message.type === 'init') {
    store = new Store(message.root)
    cache = new SharedCatalogCache(store, message.options)
    process.send({ type: 'ready' })
  } else if (message.type === 'finish') finish(message.value)
  else if (message.type === 'get') {
    try {
      const value = await cache.get(message.key, () => new Promise(resolve => {
        finish = resolve
        process.send({ type: 'request', key: message.key })
      }), { stale: false })
      process.send({ type: 'result', value })
    } catch { process.send({ type: 'failed' }) }
  }
})
