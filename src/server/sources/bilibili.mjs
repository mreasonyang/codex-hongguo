import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot } from '../paths.mjs'
import { PlayerError } from '../errors.mjs'
import { decodeCursor, encodeCursor } from './contracts.mjs'
import { allowedURL, responseBytes } from './network.mjs'
import { BilibiliAuth } from './bilibili-auth.mjs'

export const bilibiliMediaHosts = host => /(?:^|\.)(?:bilivideo\.com|bilivideo\.cn|bilivideo\.net|hdslb\.com)$/.test(host)
const headers = { Referer: 'https://www.bilibili.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36' }
const number = value => /^[1-9]\d{0,19}$/.test(String(value))
const invalidLink = () => new PlayerError('请粘贴 B 站番剧链接或 ss/ep 编号')
export function bangumiLink(input) {
  let value = String(input).trim(), match = /^(ss|ep)([1-9]\d{0,19})$/.exec(value)
  if (!match) {
    let url
    try { url = new URL(value) } catch { throw invalidLink() }
    if (url.protocol !== 'https:' || !['www.bilibili.com', 'bilibili.com'].includes(url.hostname) ||
        url.username || url.password || url.port) throw invalidLink()
    match = /^\/bangumi\/play\/(ss|ep)([1-9]\d{0,19})\/?$/.exec(url.pathname)
  }
  if (!match) throw invalidLink()
  return { [match[1] === 'ss' ? 'season_id' : 'ep_id']: match[1] + match[2] }
}
function apiError(code) {
  const error = new PlayerError(code === -101 ? 'B 站需要登录后观看'
    : code === -10403 || code === 10004 ? '该番剧需要账号拥有对应会员或购买权益'
    : code === -404 ? '番剧已下架或不存在'
    : [-412, -352, 429].includes(code) ? 'B 站暂时限制了请求，请稍后重试'
    : 'B 站暂时不可达，请稍后重试', 503)
  if (code === -101) error.code = 'LOGIN_REQUIRED'
  return error
}
const preview = data => [true, 1, '1'].includes(data.is_preview) ||
  data.play_check?.play_detail === 'PLAY_PREVIEW' || data.play_video_type === 'preview'
const drm = data => [true, 1, '1'].includes(data.is_drm) || Number(data.drm_tech_type) > 0
const plain = value => String(value || '').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")

// amagi owns endpoint construction and response handling. The documented Axios
// adapter keeps its requests inside the Host's bounded API transport. No browser
// credentials, upstream errors or signed media URLs cross the public contract.
export class BilibiliSource {
  id = 'bilibili'
  discovery = true
  // The public season index supplies discovery. Hongguo-specific seed keywords
  // must not become unrelated requests when a user switches video providers.
  recommendationTerms = []
  progressivePlayback = true
  constructor(context, { loadSdk = () => import(pathToFileURL(join(projectRoot, 'dist/vendor/amagi/index.mjs')).href).then(m => m.sdk), cookie = '' } = {}) {
    this.context = context; this.loadSdk = loadSdk
    this.seasons = new Map(); this.pending = new Map()
    this.pages = new Map()
    this.fetchMedia = context.mediaFetcher(headers)
    this.auth = new BilibiliAuth(context, (...args) => this.request(...args), { cookie, onChange: () => this.seasons.clear() })
  }
  // Registering an available Provider must not open an unused library or keep
  // the Hongguo-only profile locked on Windows. The SDK is lazy for the same reason.
  get db() {
    if (this.closed) throw new PlayerError('片源已关闭，请重新打开播放器', 503)
    if (this.database) return this.database
    mkdirSync(this.context.dataDir, { recursive: true, mode: 0o700 })
    const db = new DatabaseSync(join(this.context.dataDir, 'library.sqlite'))
    try {
      db.exec('PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS library(id TEXT PRIMARY KEY, added INTEGER NOT NULL); BEGIN IMMEDIATE')
      if (!db.prepare('PRAGMA table_info(library)').all().some(column => column.name === 'body'))
        db.exec('ALTER TABLE library ADD COLUMN body TEXT')
      db.exec('COMMIT')
    } catch (error) {
      try { db.exec('ROLLBACK') } catch { /* No transaction if opening failed. */ }
      db.close(); throw error
    }
    this.database = db
    return db
  }
  async request(method, options, signal, { cookie = this.auth.cookie() } = {}) {
    const signals = [this.context.signal, signal, AbortSignal.timeout(12000)].filter(Boolean)
    const combined = signals.length ? AbortSignal.any(signals) : undefined
    if (combined?.aborted) throw new PlayerError('请求已取消', 499)
    let failure
    const adapter = async config => {
      try {
        const url = new URL(config.url)
        for (const [key, value] of Object.entries(config.params || {})) url.searchParams.set(key, String(value))
        const response = await this.context.fetch(url, { signal: combined,
          headers: { ...headers, ...(cookie && url.hostname === 'api.bilibili.com' ? { Cookie: cookie } : {}) } })
        if (!response.ok) throw apiError(response.status)
        const data = await response.json()
        if (method === 'fetchBangumiSearch' && url.pathname.endsWith('/search/type') && data.data &&
            Object.hasOwn(data.data, 'v_voucher'))
          throw new PlayerError('B 站搜索暂时需要验证，请稍后重试', 503)
        const anonymousSigningKeys = method === 'fetchBangumiSearch' && url.pathname === '/x/web-interface/nav' &&
          data.code === -101 && data.data?.wbi_img
        if (data.code !== 0 && !anonymousSigningKeys) throw apiError(Number(data.code))
        if (cookie && method === 'fetchBangumiStreamUrl' && data.data?.isLogin === false) throw apiError(-101)
        const responseHeaders = { 'set-cookie': response.headers.getSetCookie() }
        return { data, status: response.status, statusText: '', headers: responseHeaders, config }
      } catch (error) {
        failure = error instanceof PlayerError ? error : apiError()
        throw failure
      }
    }
    try {
      if (method === 'fetchBangumiSearch' && !/(?:^|;\s*)buvid3=/.test(cookie)) {
        if (!this.visitor) {
          const response = await this.context.fetch('https://api.bilibili.com/x/frontend/finger/spi',
            { signal: combined, headers, budget: 65536 })
          const data = await response.json()
          if (!response.ok || data.code !== 0 || !/^[a-zA-Z0-9_-]{8,128}$/.test(data.data?.b_3 || '')) throw apiError()
          if (combined?.aborted) throw new PlayerError('请求已取消', 499)
          this.visitor = data.data.b_3
        }
        // Normal web search requires a visitor identifier, including when no
        // account is signed in. Keep it in memory and on the API host only.
        cookie = [cookie, 'buvid3=' + this.visitor].filter(Boolean).join('; ')
      }
      const sdk = await (this.sdk ??= this.loadSdk())
      // Logged-in calls use amagi's native account/entitlement/signing flow.
      // Its SDK boundary routes internal requests through the same adapter too.
      // Anonymous calls retain the existing H5 request and stream preferences.
      const result = await sdk[method](options, cookie, {
        adapter, signal: combined, timeout: 10000, headers: { cookie },
        ...(cookie || method !== 'fetchBangumiStreamUrl' ? {} : { params: { fnval: 16, qn: 32 } }),
      })
      if (combined?.aborted) throw new PlayerError('请求已取消', 499)
      if (!result?.success || result.data?.code !== 0) throw apiError(Number(result?.data?.code ?? result?.code))
      return result.data.result ?? result.data.data
    } catch (error) {
      if (combined?.aborted) throw new PlayerError('请求已取消', 499)
      throw failure || (error instanceof PlayerError ? error : apiError())
    }
  }
  async season(reference, signal, refresh = false) {
    const known = reference.season_id?.replace(/^ss/, '')
    const cached = this.seasons.get(known)
    if (!refresh && cached && cached.expires > Date.now()) return cached
    const key = JSON.stringify(reference)
    if (this.pending.has(key)) return this.pending.get(key)
    const job = this.request('fetchBangumiInfo', reference, signal).then(raw => {
      if (!raw || !number(raw.season_id) || typeof raw.title !== 'string' || !raw.title.trim()) throw apiError()
      const id = String(raw.season_id)
      const episodes = (raw.episodes || []).filter(ep => number(ep.id) && number(ep.cid) &&
        !/预告|PV|预览/i.test(ep.badge || '') && !/^(?:PV|预告|预览)/i.test(ep.title || '')).slice(0, 2000)
      const value = { series: { id, title: raw.title.slice(0, 320), description: String(raw.evaluate || '').slice(0, 2000),
        episodes: episodes.length, coverURL: raw.cover }, episodes, expires: Date.now() + 300000 }
      this.seasons.set(id, value)
      while (this.seasons.size > 48) this.seasons.delete(this.seasons.keys().next().value)
      return value
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, job)
    return job
  }
  async listSeries({ query = '', cursor, pageSize = 16, signal } = {}) {
    query = String(query).trim()
    const page = decodeCursor(cursor, this.id, 'browse-v2', query) ?? 1
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new PlayerError('分页信息无效')
    if (/^(?:ss|ep)\d|^https?:\/\//i.test(query)) {
      const { series } = await this.season(bangumiLink(query), signal)
      this.db.prepare('INSERT OR REPLACE INTO library(id,added,body) VALUES(?,?,?)').run(series.id, Date.now(), JSON.stringify(series))
      this.db.exec('DELETE FROM library WHERE id NOT IN (SELECT id FROM library ORDER BY added DESC,id DESC LIMIT 48)')
      this.pages.clear()
      return { items: [series], cursor: null }
    }
    const size = Math.max(1, Math.min(30, pageSize)), key = JSON.stringify([query, page, size])
    const saved = page === 1 ? (await Promise.all(this.db.prepare(
      'SELECT id,body FROM library ORDER BY added DESC,id DESC LIMIT ?').all(query ? 48 : 8).map(async row => {
      try {
        if (row.body) {
          const series = JSON.parse(row.body)
          return !query || series.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? series : null
        }
        if (query) return null
        const series = (await this.season({ season_id: 'ss' + row.id }, signal)).series
        this.db.prepare('UPDATE library SET body=? WHERE id=?').run(JSON.stringify(series), row.id)
        return series
      } catch { return null }
    }))).filter(Boolean) : []
    const mergeSaved = value => saved.length ? { ...value,
      items: [...new Map([...saved, ...value.items].map(row => [row.id, row])).values()] } : value
    const cached = this.pages.get(key)
    if (cached?.until > Date.now()) return mergeSaved(cached.value)
    let data
    try {
      data = await this.request(query ? 'fetchBangumiSearch' : 'fetchBangumiIndex',
        query ? { keyword: query, page } : { page, pageSize: size }, signal)
    } catch (error) {
      if (signal?.aborted || this.context.signal?.aborted || !saved.length) throw error
      // Searching the local library still works during an upstream outage or
      // verification challenge. Never treat a challenge as an empty online feed.
      return mergeSaved({ items: [], cursor: null })
    }
    const rows = query ? data?.result ?? (Number(data?.numResults) === 0 ? [] : undefined) : data?.list
    if (!Array.isArray(rows)) throw apiError()
    const items = rows.filter(row => number(row.season_id) && typeof row.title === 'string').slice(0, 40).map(row => ({
      id: String(row.season_id), title: plain(row.title).slice(0, 320),
      description: [plain(row.badge), plain(row.desc || row.evaluate || row.index_show || row.styles || '')].filter(Boolean).join(' · ').slice(0, 2000),
      episodes: Number(row.ep_size || row.total) || null, coverURL: row.cover,
    }))
    const more = query ? Number(data.numPages) > page : data.has_next === 1 || data.has_next === true
    const value = { items, cursor: more && items.length ? encodeCursor(this.id, 'browse-v2', query, page + 1) : null }
    this.pages.set(key, { value, until: Date.now() + 60000 })
    while (this.pages.size > 48) this.pages.delete(this.pages.keys().next().value)
    return mergeSaved(value)
  }
  localSeries() {
    return this.db.prepare('SELECT body FROM library WHERE body IS NOT NULL ORDER BY added DESC,id DESC LIMIT 48').all()
      .flatMap(row => { try { return [JSON.parse(row.body)] } catch { return [] } })
  }
  async getSeries(id, { signal } = {}) {
    if (!number(id)) throw invalidLink()
    return (await this.season({ season_id: 'ss' + id }, signal)).series
  }
  async listEpisodes(id, { cursor, pageSize = 120, signal } = {}) {
    if (!number(id)) throw invalidLink()
    const offset = decodeCursor(cursor, this.id, 'episodes', id) ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2000) throw new PlayerError('分页信息无效')
    const { episodes } = await this.season({ season_id: 'ss' + id }, signal)
    const items = episodes.slice(offset, offset + pageSize).map((ep, index) => ({
      id: id + ':' + ep.id, number: Number(ep.title) || offset + index + 1,
      label: String(ep.long_title || '第 ' + ep.title + ' 集').slice(0, 320), codec: '', playable: true,
    }))
    return { items, cursor: offset + items.length < episodes.length
      ? encodeCursor(this.id, 'episodes', id, offset + items.length) : null }
  }
  async getCover(id, { url, signal } = {}) {
    url ||= (await this.getSeries(id, { signal })).coverURL
    if (!url) return null
    const { body } = await this.fetchMedia(url, 3 * 1024 * 1024, 7000)
    return { bytes: await responseBytes(body, 3 * 1024 * 1024) }
  }
  async resolvePlayback(id, { signal } = {}) {
    const [sid, eid, extra] = String(id).split(':')
    if (!number(sid) || !number(eid) || extra !== undefined) throw new PlayerError('B 站分集编号无效')
    const { episodes } = await this.season({ season_id: 'ss' + sid }, signal, true)
    const ep = episodes.find(row => String(row.id) === eid)
    if (!ep) throw new PlayerError('该集不属于当前番剧或已下架')
    let data = await this.request('fetchBangumiStreamUrl', { ep_id: 'ep' + eid, cid: ep.cid }, signal)
    if (!data) throw apiError()
    if (data.code && Number(data.code) !== 0) throw apiError(Number(data.code))
    if (data.plugins?.some(item => item.name === 'AreaLimitPanel' && item.config?.is_block))
      throw new PlayerError('该番剧在当前地区不可播放')
    if (data.play_check?.play_detail === 'PLAY_NONE' || data.play_video_type === 'none') throw apiError(-10403)
    if (preview(data)) throw new PlayerError('B 站仅提供试看，请使用拥有完整观看权益的账号')
    data = data.video_info ?? data
    if (preview(data)) throw new PlayerError('B 站仅提供试看，请使用拥有完整观看权益的账号')
    if (drm(data)) throw new PlayerError('该集需要 DRM 播放授权，当前播放器暂不支持')
    const duration = Number(data.timelength) / 1000
    if (!(duration > 0 && duration <= 7200)) throw new PlayerError('番剧时长无效或超过两小时限制')
    const locator = track => {
      const urls = [track.baseUrl || track.base_url || track.url, ...(track.backupUrl || track.backup_url || [])].filter(Boolean)
      const segment = track.SegmentBase || track.segment_base
      return { url: allowedURL(urls[0], bilibiliMediaHosts).href,
        mime: (track.mimeType || track.mime_type || (track.codecs?.startsWith('mp4a') ? 'audio/mp4' : 'video/mp4')) + '; codecs="' + track.codecs + '"',
        ...(segment ? { initialization: segment.Initialization || segment.initialization,
          indexRange: segment.indexRange || segment.index_range } : {}),
        backupURLs: urls.slice(1, 4).flatMap(url => { try { return [allowedURL(url, bilibiliMediaHosts).href] } catch { return [] } }) }
    }
    const audio = (data.dash?.audio || []).filter(track => !drm(track) && /^mp4a\./i.test(track.codecs || ''))
      .sort((a, b) => a.bandwidth - b.bandwidth)[0]
    const authenticated = !!this.auth.cookie()
    const video = (data.dash?.video || []).filter(track => !drm(track) && /^avc[13]\./i.test(track.codecs || '') &&
      (Number(track.bandwidth) + Number(audio?.bandwidth)) * duration / 8 < 240 * 1024 * 1024)
      .sort((a, b) => (authenticated ? Number(b.id) - Number(a.id)
        : Math.abs(Number(a.id) - 32) - Math.abs(Number(b.id) - 32)) || a.bandwidth - b.bandwidth)
    if (video.length && audio) return { candidates: video.slice(0, 2).map(track => ({
      kind: 'tracks', codec: 'h264', video: locator(track), audio: locator(audio),
    })), fetchMedia: this.fetchMedia, durationMs: Math.round(duration * 1000) }
    if (data.durl?.length === 1) return { candidates: [{ kind: 'file', codec: 'h264', url: locator(data.durl[0]).url }], fetchMedia: this.fetchMedia }
    throw new PlayerError('该集暂未提供大小合适的 AVC/AAC 完整片源')
  }
  dispose() {
    this.closed = true
    this.seasons.clear(); this.pages.clear(); this.auth.dispose()
    this.database?.close(); this.database = undefined
  }
}
