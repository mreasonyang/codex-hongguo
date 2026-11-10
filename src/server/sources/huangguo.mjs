import { createClient } from './vendor/veyra-huangguo.mjs'
import { decodeCover } from './vendor/veyra-cover.mjs'
import { sourceCall, encodeCursor, decodeCursor } from './contracts.mjs'
import { allowedURL, responseBytes } from './network.mjs'
import { PlayerError } from '../errors.mjs'

const MB = 1024 * 1024
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'
const apiHosts = ['huangguoai.io', '0624.gitiecgad.cc']
const mediaDomains = ['drleao.cn', 'hzjvlo.cn', 'ovscdns.com', 'intlscdn.com', 'dnsv1.com', 'hnydns.com']
export const huangguoManifest = {
  apiVersion: 1, id: 'huangguo', name: '黄果', version: '1.0.0', nsfw: true,
  queryMode: 'search', queryHint: '搜索剧名', emptyMessage: '暂时没有找到短剧，请换个关键词试试',
  network: { api: apiHosts, media: [...apiHosts, ...mediaDomains.flatMap(host => [host, '*.' + host])] },
}
const mediaHost = host => apiHosts.includes(host) || mediaDomains.some(domain => host === domain || host.endsWith('.' + domain))
function seriesId(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) throw new PlayerError('无效剧目')
  return id
}
function pageNumber(value, initial) {
  value ??= initial
  if (!Number.isSafeInteger(value) || value < initial || value > 100000) throw new PlayerError('分页信息无效')
  return value
}

export class HuangguoSource {
  id = 'huangguo'
  progressivePlayback = true
  // Feed this source's own catalog; never supplement it with Hongguo search terms.
  recommendationTerms = []
  constructor(context) {
    this.context = context
    this.controller = new AbortController()
    this.signal = AbortSignal.any([this.controller.signal, ...(context.signal ? [context.signal] : [])])
    this.details = new Map()
    this.covers = context.mediaFetcher({ 'User-Agent': UA })
    this.client = createClient({ request: async (url, options = {}) => {
      const signal = AbortSignal.any([this.signal, ...(this.requestSignal ? [this.requestSignal] : [])])
      signal.throwIfAborted()
      const headers = new Headers(options.headers)
      if (headers.has('cookie') || headers.has('authorization')) throw new PlayerError('该片源仅使用匿名访问', 403)
      headers.set('User-Agent', UA)
      const response = await context.fetch(url, { method: options.method, body: options.body, headers, signal,
        budget: 2 * MB, timeout: Math.min(options.timeout || 10000, 10000) })
      signal.throwIfAborted()
      const labels = { 401: 'AUTHENTICATION_REQUIRED', 403: 'CONTENT_UNAVAILABLE', 404: 'NOT_FOUND', 429: 'RATE_LIMITED' }
      if (labels[response.status]) {
        await response.body?.cancel()
        throw Object.assign(new Error('Upstream request rejected'), { code: labels[response.status], status: response.status })
      }
      const bytes = await responseBytes(response.body, 2 * MB)
      signal.throwIfAborted()
      return { status: response.status, text: () => bytes.toString('utf8') }
    } })
  }
  call(method, args = [], signal) {
    const cancelled = AbortSignal.any([this.signal, ...(signal ? [signal] : [])])
    const work = async () => {
      cancelled.throwIfAborted()
      this.requestSignal = AbortSignal.any([cancelled, AbortSignal.timeout(25000)])
      try {
        const value = await this.client[method](...args)
        this.requestSignal.throwIfAborted()
        return value
      } finally { this.requestSignal = undefined }
    }
    // Keep one operation's mirror/Referer stable; cancellation also stops queued work.
    const task = (this.operations || Promise.resolve()).then(work)
    this.operations = task.catch(() => {})
    return sourceCall(() => task, cancelled)
  }
  series(row) {
    return { id: seriesId(String(row.id)), title: row.title, description: row.description || '',
      episodes: row._episodes?.length || Number(row.episodeLabel?.match(/\d+/)?.[0]) || null,
      coverURL: row.cover || undefined }
  }
  async listSeries({ query = '', cursor, pageSize = 16, signal } = {}) {
    const page = pageNumber(decodeCursor(cursor, this.id, 'list', query), 1)
    const size = Math.min(48, Math.max(1, pageSize))
    const result = await this.call(query ? 'search' : 'category', [query, page, size], signal)
    const next = result.nextPage == null ? null : pageNumber(result.nextPage, 1)
    return { items: (result.items || []).filter(row => /^[A-Za-z0-9_-]{1,64}$/.test(row.id)).map(row => this.series(row)),
      cursor: next && next > page ? encodeCursor(this.id, 'list', query, next) : null }
  }
  async detail(id, signal) {
    seriesId(id)
    let entry = this.details.get(id)
    if (!entry || entry.expires <= Date.now()) {
      entry = { expires: Date.now() + 15 * 60000, value: null }
      entry.value = this.call('detail', [id], signal).catch(error => {
        if (this.details.get(id) === entry) this.details.delete(id)
        throw error
      })
      this.details.set(id, entry)
      while (this.details.size > 128) this.details.delete(this.details.keys().next().value)
    }
    return sourceCall(() => entry.value, AbortSignal.any([this.signal, ...(signal ? [signal] : [])]))
  }
  async getSeries(id, { signal } = {}) { return this.series(await this.detail(id, signal)) }
  async listEpisodes(id, { cursor, pageSize = 120, signal } = {}) {
    const offset = pageNumber(decodeCursor(cursor, this.id, 'episodes', id), 0)
    const info = await this.detail(id, signal)
    const episodes = [...new Map(info._episodes.filter(ep => Number.isSafeInteger(ep.number) && ep.number > 0 && ep.number <= 999999)
      .map(ep => [ep.number, ep])).values()]
    const size = Math.min(120, Math.max(1, pageSize))
    return { items: episodes.slice(offset, offset + size).map(ep => ({ id: id + ':' + ep.number,
      number: ep.number, label: ep.title, codec: '', playable: true })),
      cursor: offset + size < episodes.length ? encodeCursor(this.id, 'episodes', id, offset + size) : null }
  }
  async getCover(id, { url, signal } = {}) {
    this.signal.throwIfAborted()
    url ||= (await this.getSeries(id, { signal })).coverURL
    if (!url) return null
    const { body } = await this.covers(url, 3 * MB, 7000, 0, undefined,
      AbortSignal.any([this.signal, ...(signal ? [signal] : [])]))
    const bytes = decodeCover(await responseBytes(body, 3 * MB))
    return bytes ? { bytes } : null
  }
  async resolvePlayback(id, { signal } = {}) {
    const match = typeof id === 'string' && id.match(/^([A-Za-z0-9_-]{1,64}):([1-9]\d{0,5})$/)
    if (!match) throw new PlayerError('无效分集')
    const result = await this.call('episode', [match[1], Number(match[2])], signal)
    const url = allowedURL(result.url, mediaHost).href
    const referer = allowedURL(result.referer, host => apiHosts.includes(host)).href
    return { candidates: [{ kind: 'hls', url, codec: result.codec }],
      fetchMedia: this.context.mediaFetcher({ 'User-Agent': UA, Referer: referer }) }
  }
  dispose() { this.controller.abort(); this.details.clear() }
}
