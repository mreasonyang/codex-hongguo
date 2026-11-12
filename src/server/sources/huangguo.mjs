import { createClient } from './vendor/veyra-huangguo.mjs'
import { decodeCover } from './vendor/veyra-cover.mjs'
import { sourceCall, encodeCursor, decodeCursor } from './contracts.mjs'
import { allowedURL, responseBytes } from './network.mjs'
import { PlayerError } from '../errors.mjs'
import { randomUUID } from 'node:crypto'

const MB = 1024 * 1024
const HOT_TTL = 5 * 60000, HOT_RETENTION = 30 * 60000, HOT_SNAPSHOTS = 3, HOT_ITEMS = 512
const paginationError = () => Object.assign(new PlayerError('分页信息已失效或不匹配，请重新浏览'), { code: 'CONTRACT' })
const invalidResult = () => Object.assign(new PlayerError('片源返回的数据格式无效', 503), { code: 'CONTRACT' })
const missingSeries = () => Object.assign(new PlayerError('剧目已下架或不存在', 404), { code: 'NOT_FOUND' })
const UA = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36'
const apiHosts = ['huangguoai.io', '0624.gitiecgad.cc']
const temporaryReadFailures = new Set(['获取视频列表失败', '获取视频失败'])
const terminalErrors = new Set(['ABORTED', 'RATE_LIMITED', 'AUTHENTICATION_REQUIRED', 'CONTENT_UNAVAILABLE',
  'NOT_FOUND', 'BUDGET', 'HOST_NOT_ALLOWED', 'CONTRACT'])
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
function operationPath(method, args) {
  if (method === 'search') return `/api/search?q=${encodeURIComponent(args[0])}&page=${args[1]}&size=${args[2] ?? 20}`
  if (method === 'detail' || method === 'episode') return `/api/videos/${encodeURIComponent(args[0])}`
  if (method === 'category') {
    const [category, page, size = 24] = args
    if (category === 'hot') return '/api/ranks/hot'
    if (!category || category === 'new' || category === 'latest') return `/api/videos?page=${page}&size=${size}`
    return `/api/videos/category/${encodeURIComponent(category)}?sort=hot&page=${page}&size=${size}`
  }
  throw invalidResult()
}
function responseData(data, path, origin) {
  const absolute = value => typeof value === 'string' && value.trim() ? new URL(value, origin).href : value
  const row = value => value && typeof value === 'object' ? { ...value,
    ...(path === '/api/ranks/hot' ? { id: value.video_id ?? value.id } : {}),
    ...(value.cover ? { cover: absolute(value.cover) } : {}) } : value
  if (Array.isArray(data)) return data.map(row)
  if (!data || typeof data !== 'object') return data
  const result = row(data)
  for (const key of ['items', 'list']) if (Array.isArray(data[key])) result[key] = data[key].map(row)
  if (data.streams) result.streams = { ...data.streams,
    main: absolute(data.streams.main), hevc: absolute(data.streams.hevc) }
  return result
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
    this.hotSnapshots = new Map()
    this.hotCurrent = null
    this.covers = context.mediaFetcher({ 'User-Agent': UA })
    this.base = null
  }
  async request(envelope, options, signal) {
    const preferred = this.base, origins = apiHosts.map(host => 'https://' + host)
    const bases = preferred ? [preferred, ...origins.filter(base => base !== preferred)] : origins
    let lastError
    for (const base of bases) {
      signal.throwIfAborted()
      try {
        const headers = new Headers(options.headers)
        if (headers.has('cookie') || headers.has('authorization')) throw invalidResult()
        headers.set('User-Agent', UA)
        headers.set('Origin', base)
        headers.set('Referer', base + '/')
        const response = await this.context.fetch(base + '/api/edge/request', { method: 'POST',
          body: JSON.stringify(envelope), headers, signal, budget: 2 * MB,
          timeout: Math.min(options.timeout || 10000, 10000) })
        signal.throwIfAborted()
        if (response.status < 200 || response.status >= 300) {
          await response.body?.cancel()
          const labels = { 401: 'AUTHENTICATION_REQUIRED', 403: 'CONTENT_UNAVAILABLE', 404: 'NOT_FOUND', 429: 'RATE_LIMITED' }
          throw Object.assign(new Error('Source request rejected'), { code: labels[response.status] || 'NETWORK' })
        }
        const bytes = await responseBytes(response.body, 2 * MB)
        signal.throwIfAborted()
        const payload = JSON.parse(bytes.toString('utf8'))
        if (String(payload?.status) !== '1') throw Object.assign(new Error('Source operation unavailable'), {
          code: envelope.method === 'GET' && temporaryReadFailures.has(payload?.msg) ? 'NETWORK' : 'CONTENT_UNAVAILABLE',
        })
        const requested = /^\/api\/videos\/([A-Za-z0-9_-]{1,64})$/.exec(envelope.path)
        if (requested && String(payload.data?.id || '') !== requested[1]) throw missingSeries()
        this.base = base
        const text = JSON.stringify({ ...payload, data: responseData(payload.data, envelope.path, base) })
        return { status: response.status, text: () => text, origin: base }
      } catch (error) {
        if (signal.aborted) throw Object.assign(new Error('Source request stopped'), {
          code: signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'ABORTED',
        })
        const code = error?.name === 'AbortError' ? 'ABORTED' : error?.name === 'TimeoutError' ? 'TIMEOUT' : error?.code
        lastError = Object.assign(new Error('Source request failed'), {
          code: terminalErrors.has(code) || code === 'TIMEOUT' ? code : 'NETWORK',
        })
        if (this.base === base) this.base = null
        if (envelope.method !== 'GET' || terminalErrors.has(lastError.code)) throw lastError
      }
    }
    throw lastError
  }
  async sdkCall(method, args, signal) {
    const firstPath = operationPath(method, args), requests = new Map()
    let transportError, origin
    const client = createClient({ request: (_url, options) => {
      let envelope = JSON.parse(options.body)
      // The SDK's fixed catalog probe is answered by this operation's real read.
      // Its probe and subsequent request share that response, never synthetic data.
      if (envelope.path === '/api/videos?page=1&size=1') envelope = { ...envelope,
        method: 'GET', path: firstPath, body: '', content_type: '' }
      const key = JSON.stringify(envelope)
      if (!requests.has(key)) requests.set(key, this.request(envelope, options, signal).then(reply => {
        origin = reply.origin
        return reply
      }, error => { transportError = error; throw error }))
      return requests.get(key)
    } })
    let value
    try { value = await client[method](...args) }
    catch (error) { throw transportError || error }
    // The unmodified SDK can turn a rejected hot request into an empty page.
    if (transportError) throw transportError
    return method === 'episode' ? { ...value, origin } : value
  }
  call(method, args = [], signal, completed = value => value) {
    const cancelled = AbortSignal.any([this.signal, ...(signal ? [signal] : [])])
    return sourceCall(request => {
      const work = async () => {
        request.throwIfAborted()
        const value = await this.sdkCall(method, args, request)
        request.throwIfAborted()
        // Publish only completed, non-cancelled results before releasing the queue.
        return completed(value)
      }
      // The deadline includes queue time and reaches the actual transport.
      const task = (this.operations || Promise.resolve()).then(work)
      this.operations = task.catch(() => {})
      return task
    }, cancelled)
  }
  series(row) {
    if (!row || !/^[A-Za-z0-9_-]{1,64}$/.test(row.id) || typeof row.title !== 'string' || !row.title.trim()) throw invalidResult()
    return { id: seriesId(String(row.id)), title: row.title, description: row.description || '',
      episodes: row._episodes?.length || Number(row.episodeLabel?.match(/\d+/)?.[0]) || null,
      coverURL: row.cover || undefined }
  }
  pruneHot() {
    const now = Date.now()
    for (const [id, snapshot] of this.hotSnapshots) if (now - snapshot.created >= HOT_RETENTION) this.hotSnapshots.delete(id)
    while (this.hotSnapshots.size > HOT_SNAPSHOTS) this.hotSnapshots.delete(this.hotSnapshots.keys().next().value)
    if (!this.hotSnapshots.has(this.hotCurrent)) this.hotCurrent = null
  }
  async hotSnapshot(signal) {
    this.pruneHot()
    const current = this.hotSnapshots.get(this.hotCurrent)
    if (current && Date.now() - current.created < HOT_TTL) return current
    const previous = this.hotCurrent
    return this.call('category', ['hot', 1, HOT_ITEMS], signal, result => {
      // Independently queued callers may have observed the same expired snapshot.
      // The first complete result wins; a later reply must not replace its data.
      const published = this.hotSnapshots.get(this.hotCurrent)
      if (this.hotCurrent !== previous && published) return published
      if (!Array.isArray(result?.items) || result.items.length > HOT_ITEMS || result.nextPage != null) throw invalidResult()
      const items = result.items.map(row => this.series(row))
      if (new Set(items.map(row => row.id)).size !== items.length) throw invalidResult()
      const snapshot = { id: randomUUID(), created: Date.now(), items }
      this.hotSnapshots.set(snapshot.id, snapshot)
      this.hotCurrent = snapshot.id
      this.pruneHot()
      return snapshot
    })
  }
  async listSeries({ query = '', cursor, pageSize = 16, signal } = {}) {
    const active = AbortSignal.any([this.signal, ...(signal ? [signal] : [])])
    return sourceCall(async () => {
      if (!Number.isSafeInteger(pageSize) || pageSize < 1) throw paginationError()
      const size = Math.min(48, pageSize)
      let state
      if (cursor != null) {
        try { state = decodeCursor(cursor, this.id, 'list', query) } catch { throw paginationError() }
        if (!state || state.size !== size || state.kind !== (query ? 'search' : 'hot')) throw paginationError()
      }
      if (query) {
        const page = state ? state.page : 1
        if (!Number.isSafeInteger(page) || page < (state ? 2 : 1) || page > 100000) throw paginationError()
        const result = await this.call('search', [query, page, size], active)
        if (!Array.isArray(result?.items)) throw invalidResult()
        const next = result.nextPage == null ? null : result.nextPage
        if (next !== null && (next !== page + 1 || next > 100000)) throw paginationError()
        return { items: result.items.map(row => this.series(row)),
          cursor: next === null ? null : encodeCursor(this.id, 'list', query, { kind: 'search', size, page: next }) }
      }
      this.pruneHot()
      const snapshot = state ? this.hotSnapshots.get(state.snapshot) : await this.hotSnapshot(active)
      if (!snapshot) throw paginationError()
      const offset = state ? state.offset : 0
      if (!Number.isSafeInteger(offset) || offset < 0 || (state && (offset < size || offset % size || offset >= snapshot.items.length))) throw paginationError()
      return { items: snapshot.items.slice(offset, offset + size).map(row => ({ ...row })),
        cursor: offset + size < snapshot.items.length ? encodeCursor(this.id, 'list', query,
          { kind: 'hot', size, snapshot: snapshot.id, offset: offset + size }) : null }
    }, active)
  }
  async detail(id, signal) {
    seriesId(id)
    const active = AbortSignal.any([this.signal, ...(signal ? [signal] : [])])
    return sourceCall(() => {
      const entry = this.details.get(id)
      if (entry && entry.expires > Date.now()) return entry.value
      if (entry) this.details.delete(id)
      // Pending requests belong to their caller, never to the shared cache.
      return this.call('detail', [id], active, value => {
        if (value?.id !== id) throw missingSeries()
        this.series(value)
        if (!Array.isArray(value._episodes)) throw invalidResult()
        this.details.set(id, { expires: Date.now() + 15 * 60000, value })
        while (this.details.size > 128) this.details.delete(this.details.keys().next().value)
        return value
      })
    }, active)
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
    const original = allowedURL(result.referer, host => apiHosts.includes(host))
    if (original.pathname !== `/video/${match[1]}/`) throw missingSeries()
    const origin = allowedURL(result.origin, host => apiHosts.includes(host)).origin
    const referer = new URL(original.pathname, origin).href
    return { candidates: [{ kind: 'hls', url, codec: result.codec }],
      fetchMedia: this.context.mediaFetcher({ 'User-Agent': UA, Referer: referer }) }
  }
  dispose() { this.controller.abort(); this.details.clear(); this.hotSnapshots.clear(); this.hotCurrent = null }
}
