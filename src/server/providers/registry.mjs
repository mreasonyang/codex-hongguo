import { lstat, readdir, readFile, realpath } from 'node:fs/promises'
import { resolve, join, sep, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HongguoSource } from '../sources/hongguo.mjs'
import { BilibiliSource } from '../sources/bilibili.mjs'
import { sourceId, parseId } from '../sources/ids.mjs'
import { sourceCall } from '../sources/contracts.mjs'
import { boundedResponse, responseBytes, mediaFetcher } from '../sources/network.mjs'
import { PlayerError } from '../errors.mjs'
import { videoCategories } from '../sources/bilibili-content.mjs'

const methods = ['listSeries', 'getSeries', 'listEpisodes', 'getCover', 'resolvePlayback']
export const builtins = [
  { manifest: { apiVersion: 1, id: 'hongguo', name: '红果', version: '1.0.0', nsfw: false }, createProvider: ctx => new HongguoSource(ctx.root) },
  { manifest: { apiVersion: 1, id: 'bilibili', name: '哔哩哔哩', version: '1.0.0',
    authentication: 'qrcode', nsfw: false,
    contentTypes: [
      { id: 'bangumi', name: '番剧', queryHint: '搜索番名，也可粘贴番剧链接', emptyMessage: '暂时没有找到番剧，请换个关键词试试' },
      { id: 'video', name: '视频', queryHint: '搜索视频，也可粘贴 BV/AV 编号或链接', emptyMessage: '暂时没有找到视频，请换个关键词试试', categories: videoCategories },
    ],
    queryMode: 'search', queryHint: '搜索番名，也可粘贴番剧链接', emptyMessage: '暂时没有找到番剧，请换个关键词试试',
    network: { api: ['api.bilibili.com', 'passport.bilibili.com', 'passport.biligame.com'], media: ['*.bilivideo.com', '*.bilivideo.cn', '*.bilivideo.net', '*.hdslb.com'] } },
    createProvider: ctx => new BilibiliSource(ctx, { cookie: process.env.HONGGUO_BILIBILI_COOKIE || '' }) },
]
function validate(manifest) {
  if (!manifest || manifest.apiVersion !== 1 || sourceId(manifest.id) !== manifest.id ||
      typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 80 ||
      typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw Error('MANIFEST')
  for (const entries of Object.values(manifest.network || {})) {
    if (!Array.isArray(entries) || entries.length > 32 || entries.some(host => typeof host !== 'string' ||
        !/^(?:\*\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(host))) throw Error('NETWORK_POLICY')
  }
  for (const key of ['queryHint', 'emptyMessage'])
    if (manifest[key] !== undefined && (typeof manifest[key] !== 'string' || manifest[key].length > 160)) throw Error('MANIFEST')
  if (manifest.queryMode !== undefined && !['search', 'link'].includes(manifest.queryMode)) throw Error('MANIFEST')
  if (manifest.authentication !== undefined && manifest.authentication !== 'qrcode') throw Error('MANIFEST')
  for (const key of ['nsfw', 'enabled'])
    if (manifest[key] !== undefined && typeof manifest[key] !== 'boolean') throw Error('MANIFEST')
  if (manifest.contentTypes !== undefined) {
    if (!Array.isArray(manifest.contentTypes) || !manifest.contentTypes.length || manifest.contentTypes.length > 8) throw Error('MANIFEST')
    const ids = new Set()
    for (const type of manifest.contentTypes) {
      if (typeof type?.id !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/.test(type.id) || ids.has(type.id) ||
          typeof type.name !== 'string' || !type.name.trim() || type.name.length > 40) throw Error('MANIFEST')
      ids.add(type.id)
      for (const key of ['queryHint', 'emptyMessage'])
        if (type[key] !== undefined && (typeof type[key] !== 'string' || type[key].length > 160)) throw Error('MANIFEST')
      if (type.categories !== undefined) {
        if (!Array.isArray(type.categories) || type.categories.length > 32 || new Set(type.categories.map(c => c.id)).size !== type.categories.length ||
            type.categories.some(c => typeof c.id !== 'string' || !/^[a-z0-9-]{0,24}$/.test(c.id) || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 40)) throw Error('MANIFEST')
      }
    }
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
    this.definitions = new Map()
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
      fetchMedia: mediaFetcher({ allows: allows(network.media), signal: controller.signal }),
      mediaFetcher: headers => mediaFetcher({ allows: allows(network.media), headers, signal: controller.signal }),
      fetch: async (url, options = {}) => {
        const { response } = await boundedResponse(url, { ...options,
          signal: AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]),
          allows: allows(network.api), budget: Math.min(options.budget || 2 * 1024 * 1024, 2 * 1024 * 1024),
          timeout: Math.min(options.timeout || 10000, 30000) })
        return new Response(response.body ? await responseBytes(response.body, 2 * 1024 * 1024) : null,
          { status: response.status, headers: response.headers })
      },
    }
  }
  accept(manifest, adapter, builtin, context) {
    if (this.adapters.has(manifest.id) || !adapter || adapter.id !== manifest.id || methods.some(method => typeof adapter[method] !== 'function')) throw Error('CONTRACT')
    if (manifest.authentication && ['status', 'start', 'poll', 'cancel', 'logout'].some(method => typeof adapter.auth?.[method] !== 'function')) throw Error('AUTH_CONTRACT')
    this.adapters.set(manifest.id, adapter)
    this.fetchers.set(manifest.id, adapter.fetchMedia || context.fetchMedia)
    Object.assign(this.definitions.get(manifest.id).status, { available: true, code: undefined })
  }
  register(manifest, factory, builtin = false) {
    validate(manifest)
    if (this.definitions.has(manifest.id)) throw Error('DUPLICATE')
    const status = { id: manifest.id, name: manifest.name, version: manifest.version, builtin,
      ...(manifest.queryHint ? { queryHint: manifest.queryHint } : {}),
      ...(manifest.queryMode ? { queryMode: manifest.queryMode } : {}),
      ...(manifest.emptyMessage ? { emptyMessage: manifest.emptyMessage } : {}),
      ...(manifest.authentication ? { authentication: manifest.authentication } : {}),
      ...(manifest.contentTypes ? { contentTypes: structuredClone(manifest.contentTypes) } : {}),
      nsfw: manifest.nsfw ?? false,
      enabled: manifest.enabled !== false, available: false, code: 'DISABLED' }
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
  contentContext(source, preferences = {}, overrides = {}, resolveCategory = true) {
    const types = this.definitions.get(source)?.manifest.contentTypes
    if (!types) {
      if (overrides.contentType || overrides.category) throw new PlayerError('该片源不支持此内容类型')
      return {}
    }
    const saved = preferences.contentPreferences?.[source] || {}
    const contentType = overrides.contentType ?? saved.contentType ?? types[0].id
    const type = types.find(t => t.id === contentType)
    if (!type) throw new PlayerError('内容类型无效')
    const category = overrides.category ?? (saved.contentType === contentType ? saved.category : '') ?? ''
    if (!type.categories) {
      if (category) throw new PlayerError('内容分区无效')
      return { contentType }
    }
    if (!type.categories.some(c => c.id === category)) throw new PlayerError('内容分区无效')
    const preferred = resolveCategory && !category ? this.get(source).preferredCategory?.() : undefined
    return { contentType, category: preferred && type.categories.some(c => c.id === preferred) ? preferred : category || (resolveCategory ? 'all' : '') }
  }
  get(id = 'hongguo') {
    const adapter = this.adapters.get(sourceId(id))
    if (!adapter) throw new PlayerError('片源插件不可用，请切换其他片源', 503)
    return adapter
  }
  fallback(id) { return this.adapters.has(id) ? id : 'hongguo' }
  requiresConfirmation(id) { return this.definitions.get(id)?.status.nsfw === true }
  defaultSource(id) { return this.requiresConfirmation(id) ? 'hongguo' : this.fallback(id) }
  forId(id, kind) { const ref = parseId(id, kind); return { adapter: this.get(ref.source), ...ref } }
  async resolvePlayback(id) {
    await this.ready
    const { adapter, id: raw } = this.forId(id, 'episode')
    const descriptor = await sourceCall(() => adapter.resolvePlayback(raw))
    return { ...descriptor, fetchMedia: descriptor.fetchMedia || this.fetchers.get(adapter.id) }
  }
  async dispose() {
    await this.ready
    for (const controller of this.controllers.values()) controller.abort()
    await Promise.allSettled([...this.adapters.values()].map(adapter => bounded(Promise.resolve().then(() => adapter.dispose?.()), 1000)))
  }
}
