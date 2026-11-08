import { createClient, HGHUB_LINES, fetchMirrors, decryptCover, isMediaHost, isImageHost } from './vendor/hghub.mjs'
import { sourceCall, encodeCursor, decodeCursor } from './contracts.mjs'
import { boundedResponse, responseBytes, mediaFetcher, allowedURL } from './network.mjs'
import { PlayerError } from '../errors.mjs'

const MB = 1024 * 1024
const anonymous = { load: async () => null, save: async () => {}, reset: async () => {} }
export class HghubSource {
  id = 'hghub'
  constructor({ signal } = {}) {
    this.signal = signal
    this.apiHosts = new Set(HGHUB_LINES.map(line => new URL(line.url).hostname))
    this.details = new Map()
    this.fetchMedia = mediaFetcher({ allows: isMediaHost, headers: target => ({
      'user-agent': this.client?.userAgent || 'Mozilla/5.0', referer: target.origin + '/',
    }) })
  }
  async apiFetch(url, options = {}) {
    const headers = new Headers(options.headers)
    if (headers.has('authorization') || headers.has('cookie')) throw new PlayerError('此片源仅使用匿名访问', 403)
    const { response } = await boundedResponse(url, { allows: host => this.apiHosts.has(host),
      budget: 2 * MB, timeout: 10000,
      signal: this.signal ? AbortSignal.any([this.signal, ...(options.signal ? [options.signal] : [])]) : options.signal,
      headers, method: options.method, body: options.body })
    const bytes = await responseBytes(response.body, 2 * MB)
    return new Response(bytes, { status: response.status, headers: response.headers })
  }
  async sdk() {
    this.pending ??= createClient({ store: anonymous, retries: 1, timeoutMs: 10000, minIntervalMs: 250,
      fetch: this.apiFetch.bind(this) }).then(client => this.client = client)
      .catch(error => { this.pending = null; throw error })
    return this.pending
  }
  async mirrors() {
    if (this.mirrorAt && Date.now() - this.mirrorAt < 300000) return this.mirrorLines
    const result = await fetchMirrors({ limit: 4, fetchImpl: async (url, options) => {
      const { response } = await boundedResponse(url, { allows: host => host === 'huangguoai.pages.dev',
        budget: 256 * 1024, timeout: 7000, headers: options.headers, signal: this.signal })
      return new Response(await responseBytes(response.body, 256 * 1024), { status: response.status, headers: response.headers })
    } })
    this.mirrorLines = result.items.map(item => item.url).filter(url => {
      try {
        const u = allowedURL(url, host => /^(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(host))
        this.apiHosts.add(u.hostname); return true
      } catch { return false }
    })
    this.mirrorAt = Date.now()
    return this.mirrorLines
  }
  async call(method, args = [], signal) {
    if (this.signal) signal = AbortSignal.any([this.signal, ...(signal ? [signal] : [])])
    const work = async () => {
      const client = await this.sdk()
      const tried = new Set()
      let lines = [client.base, ...HGHUB_LINES.map(line => line.url)], last
      for (let attempt = 0; attempt < 4; attempt++) {
        let base = lines.find(line => !tried.has(line))
        if (!base && tried.size < 4) {
          lines = await this.mirrors().catch(() => [])
          base = lines.find(line => !tried.has(line))
        }
        if (!base) break
        signal?.throwIfAborted()
        tried.add(base); client.setBase(base)
        try { return await client[method](...args) }
        catch (error) {
          last = error
          // Rate limiting and authorization/content failures must not fan out across mirrors.
          if (!['NETWORK', 'BAD_JSON', 'EDGE_ERROR', 'HTTP'].includes(error?.code) || error?.status === 429) throw error
        }
      }
      throw last || Error('Source unavailable')
    }
    // Bind one operation to one line, including its headers and retries.
    const task = (this.operations || Promise.resolve()).then(() => sourceCall(work, signal))
    this.operations = task.catch(() => {})
    return task
  }
  series(row) {
    return { id: String(row.id), title: row.title, description: row.description || '',
      episodes: row.episodes || null, coverURL: row.cover }
  }
  async listSeries({ query = '', cursor, pageSize = 16, signal } = {}) {
    const page = decodeCursor(cursor, this.id, 'list', query) ?? 1
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new PlayerError('分页信息无效')
    const result = await this.call(query ? 'search' : 'feed', query
      ? [query, { page, size: pageSize }] : [{ page, size: pageSize }], signal)
    return { items: (result.items || []).filter(s => /^\d{1,32}$/.test(s.id)).map(s => this.series(s)),
      cursor: page < result.pages ? encodeCursor(this.id, 'list', query, page + 1) : null }
  }
  async detail(id, signal) {
    let entry = this.details.get(id)
    if (!entry || entry.expires < Date.now()) {
      entry = { expires: Date.now() + 15 * 60000,
        value: this.call('getVideo', [id], signal).catch(error => { this.details.delete(id); throw error }) }
      this.details.set(id, entry)
      while (this.details.size > 160) this.details.delete(this.details.keys().next().value)
    }
    return sourceCall(() => entry.value, signal)
  }
  async getSeries(id, { signal } = {}) { return this.series(await this.detail(id, signal)) }
  async listEpisodes(id, { cursor, pageSize = 120, signal } = {}) {
    const offset = decodeCursor(cursor, this.id, 'episodes', id) ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw new PlayerError('分页信息无效')
    const detail = await this.detail(id, signal)
    const items = detail.episodeList.filter(e => Number.isSafeInteger(e.number) && e.number > 0 && e.number <= 999999)
    return { items: items.slice(offset, offset + pageSize).map(e => ({ id: id + '_' + e.number,
      number: e.number, label: e.title || '第 ' + e.number + ' 集', codec: '', playable: e.playable !== false })),
    cursor: offset + pageSize < items.length ? encodeCursor(this.id, 'episodes', id, offset + pageSize) : null }
  }
  async getCover(id, { url, signal } = {}) {
    url ||= (await this.getSeries(id, { signal })).coverURL
    if (!url) return null
    const fetchCover = mediaFetcher({ allows: isImageHost })
    const { body } = await fetchCover(url, 3 * MB, 7000)
    return { mime: 'image/jpeg', bytes: decryptCover(await responseBytes(body, 3 * MB)) }
  }
  resolvePlayback(id, { signal } = {}) {
    const [videoId, ep] = id.split('_')
    return sourceCall(async () => {
      const info = await this.call('getPlay', [videoId, Number(ep)], signal)
      return { candidates: [{ kind: 'hls', url: info.videoUrl }], fetchMedia: this.fetchMedia }
    }, signal)
  }
}
