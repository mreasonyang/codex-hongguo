import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { resolve, join, sep, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HongguoSource } from '../sources/hongguo.mjs'
import { HghubSource } from '../sources/hghub.mjs'
import { sourceId, parseId } from '../sources/ids.mjs'
import { sourceCall } from '../sources/contracts.mjs'
import { boundedResponse, responseBytes, mediaFetcher } from '../sources/network.mjs'
import { PlayerError } from '../errors.mjs'

const methods = ['listSeries', 'getSeries', 'listEpisodes', 'getCover', 'resolvePlayback']
export const builtins = [
  { manifest: { apiVersion: 1, id: 'hongguo', name: '红果', version: '1.0.0' }, createProvider: ctx => new HongguoSource(ctx.root) },
  { manifest: { apiVersion: 1, id: 'hghub', name: '黄果', version: '1.0.0' }, createProvider: ctx => new HghubSource({ signal: ctx.signal }) },
]
function validate(manifest) {
  if (!manifest || manifest.apiVersion !== 1 || sourceId(manifest.id) !== manifest.id ||
      typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 80 ||
      typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw Error('MANIFEST')
  for (const entries of Object.values(manifest.network || {})) {
    if (!Array.isArray(entries) || entries.length > 32 || entries.some(host => typeof host !== 'string' ||
        !/^(?:\*\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(host))) throw Error('NETWORK_POLICY')
  }
  return manifest
}
function allows(hosts = []) {
  return host => hosts.some(rule => rule.startsWith('*.') ? host.endsWith(rule.substring(1)) : host === rule)
}
function bounded(task, ms = 3000) {
  let timer
  return Promise.race([task, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('TIMEOUT')), ms) })])
    .finally(() => clearTimeout(timer))
}
// Local plugins are explicitly selected, trusted Node.js code, not a security sandbox.
// Loader/factory failures are isolated; arbitrary code can still exhaust/crash its process.
export class ProviderRegistry {
  constructor(root, options = {}) {
    this.root = root
    this.adapters = new Map(); this.status = []; this.controllers = new Map(); this.fetchers = new Map()
    this.definitions = new Map(); this.enabled = new Set(options.enabled ?? ['hongguo'])
    const pending = []
    for (const plugin of options.builtins || builtins) {
      const task = this.register(plugin.manifest, plugin.createProvider, true)
      if (task?.then) pending.push(task)
    }
    const directory = options.directory ?? process.env.HONGGUO_PROVIDERS_DIR
    this.loaded = !directory && !pending.length
    this.ready = Promise.all(pending).then(() => this.loadDirectory(directory)).catch(() => {
      this.status.push({ id: 'local-providers', name: '本地 Provider', available: false, code: 'DIRECTORY_UNAVAILABLE' })
    }).finally(() => { this.loaded = true })
  }
  context(manifest) {
    const controller = new AbortController()
    this.controllers.set(manifest.id, controller)
    const network = manifest.network || {}
    return { apiVersion: 1, id: manifest.id, root: this.root,
      dataDir: join(this.root, 'device', 'providers', manifest.id), signal: controller.signal,
      fetchMedia: mediaFetcher({ allows: allows(network.media) }),
      mediaFetcher: headers => mediaFetcher({ allows: allows(network.media), headers }),
      fetch: async (url, options = {}) => {
        const { response } = await boundedResponse(url, { ...options,
          signal: AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]),
          allows: allows(network.api), budget: Math.min(options.budget || 2 * 1024 * 1024, 2 * 1024 * 1024),
          timeout: Math.min(options.timeout || 10000, 30000) })
        return new Response(await responseBytes(response.body, 2 * 1024 * 1024), { status: response.status, headers: response.headers })
      },
    }
  }
  accept(manifest, adapter, builtin, context) {
    if (this.adapters.has(manifest.id) || !adapter || adapter.id !== manifest.id || methods.some(method => typeof adapter[method] !== 'function')) throw Error('CONTRACT')
    this.adapters.set(manifest.id, adapter)
    this.fetchers.set(manifest.id, adapter.fetchMedia || context.fetchMedia)
    Object.assign(this.definitions.get(manifest.id).status, { available: true, code: undefined })
  }
  register(manifest, factory, builtin = false) {
    validate(manifest)
    if (this.definitions.has(manifest.id)) throw Error('DUPLICATE')
    const status = { id: manifest.id, name: manifest.name, version: manifest.version, builtin,
      enabled: this.enabled.has(manifest.id) && manifest.enabled !== false,
      configurable: manifest.enabled !== false, available: false, code: 'DISABLED' }
    const definition = { manifest, factory, builtin, status }
    this.definitions.set(manifest.id, definition); this.status.push(status)
    if (status.enabled) return this.start(definition)
  }
  start({ manifest, factory, builtin, status }) {
    const context = this.context(manifest)
    const failed = () => {
      this.controllers.get(manifest.id)?.abort(); this.controllers.delete(manifest.id)
      Object.assign(status, { available: false, code: 'LOAD_FAILED' })
    }
    try {
      const value = factory(context)
      if (value && typeof value.then === 'function') return bounded(Promise.resolve(value).then(adapter => {
        if (context.signal.aborted) return bounded(Promise.resolve().then(() => adapter?.dispose?.()), 1000).catch(() => {})
        return this.accept(manifest, adapter, builtin, context)
      })).catch(failed)
      this.accept(manifest, value, builtin, context)
    } catch { failed() }
  }
  async loadDirectory(directory) {
    if (!directory) return
    const stat = await lstat(directory)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('DIRECTORY')
    const root = await realpath(directory)
    const entries = await readdir(root, { withFileTypes: true })
    const deadline = Date.now() + 6000
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name)).slice(0, 32)) {
      if (Date.now() >= deadline) {
        this.status.push({ id: 'local-providers', name: '本地 Provider', available: false, code: 'LOAD_TIMEOUT' }); break
      }
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue
      let manifest
      try {
        const dir = join(root, entry.name), path = join(dir, 'provider.json')
        const stat = await lstat(path)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw Error('MANIFEST')
        manifest = validate(JSON.parse(await readFile(path, 'utf8')))
        if (this.definitions.has(manifest.id)) throw Error('DUPLICATE')
        if (typeof manifest.entry !== 'string' || isAbsolute(manifest.entry) || !manifest.entry.endsWith('.mjs')) throw Error('ENTRY')
        const requested = resolve(dir, manifest.entry)
        if (!requested.startsWith(dir + sep)) throw Error('ENTRY')
        const fileStat = await lstat(requested)
        if (!fileStat.isFile() || fileStat.isSymbolicLink()) throw Error('ENTRY')
        const file = await realpath(requested)
        if (!file.startsWith(dir + sep)) throw Error('ENTRY')
        await this.register(manifest, async context => {
          const module = await bounded(import(pathToFileURL(file).href))
          if (typeof module.createProvider !== 'function') throw Error('CONTRACT')
          return module.createProvider(context)
        })
      } catch {
        if (manifest && !this.adapters.has(manifest.id)) { this.controllers.get(manifest.id)?.abort(); this.controllers.delete(manifest.id) }
        this.status.push({ id: manifest?.id || 'invalid-provider', name: manifest?.name || '本地 Provider', available: false, code: 'LOAD_FAILED' })
      }
    }
  }
  list() { return this.status.map(row => ({ ...row })) }
  validateEnabled(ids) {
    if (!Array.isArray(ids) || !ids.includes('hongguo') || ids.length > 32 ||
        ids.some(id => !this.definitions.get(id)?.status.configurable))
      throw new PlayerError('请选择已安装的片源，并保留红果', 400)
  }
  configure(ids) {
    this.configuring = (this.configuring ?? Promise.resolve()).catch(() => {}).then(async () => {
      await this.ready
      this.enabled = new Set(ids)
      for (const definition of this.definitions.values()) {
        const { manifest, status } = definition
        const enabled = this.enabled.has(manifest.id) && status.configurable
        if (status.enabled === enabled) continue
        status.enabled = enabled
        if (enabled) await this.start(definition)
        else {
          const adapter = this.adapters.get(manifest.id)
          this.adapters.delete(manifest.id); this.fetchers.delete(manifest.id)
          this.controllers.get(manifest.id)?.abort(); this.controllers.delete(manifest.id)
          Object.assign(status, { available: false, code: 'DISABLED' })
          if (adapter) await bounded(Promise.resolve().then(() => adapter.dispose?.()), 1000).catch(() => {})
        }
      }
    })
    return this.configuring
  }
  get(id = 'hongguo') {
    const adapter = this.adapters.get(sourceId(id))
    if (!adapter) throw new PlayerError('片源插件不可用，请切换其他片源', 503)
    return adapter
  }
  fallback(id) { return this.adapters.has(id) ? id : 'hongguo' }
  forId(id, kind) { const ref = parseId(id, kind); return { adapter: this.get(ref.source), ...ref } }
  async resolvePlayback(id) {
    await this.ready
    const { adapter, id: raw } = this.forId(id, 'episode')
    const descriptor = await sourceCall(() => adapter.resolvePlayback(raw))
    return { ...descriptor, fetchMedia: descriptor.fetchMedia || this.fetchers.get(adapter.id) }
  }
  async dispose() {
    await this.ready
    await this.configuring?.catch(() => {})
    for (const controller of this.controllers.values()) controller.abort()
    await Promise.allSettled([...this.adapters.values()].map(adapter => bounded(Promise.resolve().then(() => adapter.dispose?.()), 1000)))
  }
}
