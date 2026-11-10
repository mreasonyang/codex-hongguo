import { mkdirSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot } from '../paths.mjs'
import { PlayerError } from '../errors.mjs'
import { decodeCursor, encodeCursor } from './contracts.mjs'
import { allowedURL, responseBytes } from './network.mjs'
import { videoLink, videoId, videoPattern, contentKind, videoCategory } from './bilibili-content.mjs'
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
    : code === -10403 || code === 10004 ? '该内容需要账号拥有对应会员或购买权益'
    : code === -404 ? '内容已下架或不存在'
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
const durationMs = value => {
  const seconds = typeof value === 'number' ? value : /^\d{1,3}:\d{2}(?::\d{2})?$/.test(value || '')
    ? value.split(':').reduce((sum, part) => sum * 60 + Number(part), 0) : 0
  return seconds > 0 && seconds <= 86400 ? seconds * 1000 : undefined
}

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
    this.seasons = new Map(); this.videos = new Map(); this.pending = new Map()
    this.pages = new Map()
    this.fetchMedia = context.mediaFetcher(headers)
    this.auth = new BilibiliAuth(context, (...args) => this.request(...args), { cookie, onChange: () => { this.seasons.clear(); this.videos.clear(); this.pages.clear() } })
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
      db.exec('CREATE TABLE IF NOT EXISTS video_interests(category TEXT PRIMARY KEY, watched_at INTEGER NOT NULL); COMMIT')
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
        if (['fetchBangumiSearch', 'fetchVideoSearch'].includes(method) && url.pathname.endsWith('/search/type') && data.data &&
            Object.hasOwn(data.data, 'v_voucher'))
          throw new PlayerError('B 站搜索暂时需要验证，请稍后重试', 503)
        const anonymousSigningKeys = ['fetchBangumiSearch', 'fetchVideoSearch'].includes(method) && url.pathname === '/x/web-interface/nav' &&
          data.code === -101 && data.data?.wbi_img
        if (data.code !== 0 && !anonymousSigningKeys) throw apiError(Number(data.code))
        if (cookie && ['fetchBangumiStreamUrl', 'fetchVideoStreamUrl'].includes(method) && data.data?.isLogin === false) throw apiError(-101)
        const responseHeaders = { 'set-cookie': response.headers.getSetCookie() }
        return { data, status: response.status, statusText: '', headers: responseHeaders, config }
      } catch (error) {
        failure = error instanceof PlayerError ? error : apiError()
        throw failure
      }
    }
    try {
      const needsVisitor = ['fetchBangumiSearch', 'fetchVideoSearch'].includes(method) ||
        (method === 'fetchVideoIndex' && options.category !== 'all')
      if (needsVisitor && !/(?:^|;\s*)buvid3=/.test(cookie)) {
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
        ...(cookie || !['fetchBangumiStreamUrl', 'fetchVideoStreamUrl'].includes(method) ? {} : {
          params: { fnval: 16, qn: 32, ...(method === 'fetchVideoStreamUrl' ? { platform: 'pc' } : {}) },
        }),
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
        episodes: episodes.length, coverURL: raw.cover, contentType: 'bangumi' }, episodes, expires: Date.now() + 300000 }
      this.seasons.set(id, value)
      while (this.seasons.size > 48) this.seasons.delete(this.seasons.keys().next().value)
      return value
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, job)
    return job
  }
  async listSeries({ query = '', cursor, pageSize = 16, signal, contentType = 'bangumi', category = 'all' } = {}) {
    query = String(query).trim()
    const directVideo = /^(?:BV[0-9A-Za-z]{10}$|av[1-9]\d*$)/i.test(query) || /^https?:\/\/[^/]+\/video\//i.test(query)
    const directSeason = /^(?:ss|ep)\d/i.test(query) || /^https?:\/\/[^/]+\/bangumi\//i.test(query)
    if (directVideo || (contentType === 'video' && !directSeason)) return this.listVideos({ query, cursor, pageSize, signal, category })
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
          if (contentKind(series.id) !== 'bangumi') return null
          return !query || series.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()) ? series : null
        }
        if (query || !number(row.id)) return null
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
      episodes: Number(row.ep_size || row.total) || null, coverURL: row.cover, contentType: 'bangumi',
    }))
    const more = query ? Number(data.numPages) > page : data.has_next === 1 || data.has_next === true
    const value = { items, cursor: more && items.length ? encodeCursor(this.id, 'browse-v2', query, page + 1) : null }
    this.pages.set(key, { value, until: Date.now() + 60000 })
    while (this.pages.size > 48) this.pages.delete(this.pages.keys().next().value)
    return mergeSaved(value)
  }
  async video(reference, signal, refresh = false) {
    let bvid = reference.bvid
    if (!bvid && reference.avid) {
      const sdk = await (this.sdk ??= this.loadSdk())
      bvid = sdk.av2bv(reference.avid)
    }
    if (!videoPattern.test(bvid || '')) throw new PlayerError('视频编号无效')
    const cached = this.videos.get(bvid)
    if (!refresh && cached?.expires > Date.now()) return cached
    const key = 'video:' + bvid
    if (this.pending.has(key)) return this.pending.get(key)
    const job = this.request('fetchVideoInfo', { bvid }, signal).then(raw => {
      if (!raw || raw.bvid !== bvid || !Number.isSafeInteger(raw.aid) || raw.aid <= 0 || !raw.title?.trim()) throw apiError()
      // Interactive branches and PGC redirects need their own navigation model.
      if (raw.rights?.is_stein_gate || raw.stein_guide_cid) throw new PlayerError('互动视频暂不支持，请在 B 站打开')
      if (raw.redirect_url) throw new PlayerError('该内容请使用对应的 B 站番剧链接打开')
      const seen = new Set()
      const pages = (raw.pages || []).filter(p => {
        if (!Number.isSafeInteger(p.cid) || p.cid <= 0 || !Number.isSafeInteger(p.page) || p.page < 1 || seen.has(p.cid)) return false
        seen.add(p.cid); return true
      }).sort((a, b) => a.page - b.page).slice(0, 2000)
      if (!pages.length) throw new PlayerError('该视频没有可播放的分 P')
      const series = { id: key, title: plain(raw.title).slice(0, 320), description: plain(raw.desc).slice(0, 2000),
        episodes: pages.length, coverURL: raw.pic, contentType: 'video', author: plain(raw.owner?.name).slice(0, 80),
        durationMs: Math.max(0, Number(raw.duration) || 0) * 1000, category: videoCategory(raw.tid) }
      const value = { series, pages, aid: raw.aid, expires: Date.now() + 300000 }
      this.videos.set(bvid, value)
      while (this.videos.size > 48) this.videos.delete(this.videos.keys().next().value)
      return value
    }).finally(() => this.pending.delete(key))
    this.pending.set(key, job)
    return job
  }
  remember(series) {
    const { defaultEpisodeId, ...body } = series
    this.db.prepare('INSERT OR REPLACE INTO library(id,added,body) VALUES(?,?,?)').run(body.id, Date.now(), JSON.stringify(body))
    this.db.exec('DELETE FROM library WHERE id NOT IN (SELECT id FROM library ORDER BY added DESC,id DESC LIMIT 48)')
  }
  contentTypeOfId(id) { return contentKind(id) }
  preferredCategory() {
    return this.db.prepare('SELECT category FROM video_interests ORDER BY watched_at DESC LIMIT 1').get()?.category || 'all'
  }
  recordWatch(id) {
    if (!videoId(id)) return
    const series = this.videos.get(id.slice(6))?.series
    if (!series) return
    this.remember(series)
    if (series.category) this.db.prepare('INSERT OR REPLACE INTO video_interests VALUES(?,?)').run(series.category, Date.now())
  }
  async listVideos({ query = '', cursor, pageSize = 16, signal, category = 'all' } = {}) {
    const scope = JSON.stringify([query, category])
    const page = decodeCursor(cursor, this.id, 'videos-v1', scope) ?? 1
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000) throw new PlayerError('分页信息无效')
    if (/^(?:BV[0-9A-Za-z]{10}|av[1-9]\d*)$|^https?:\/\//i.test(query)) {
      if (cursor) throw new PlayerError('视频链接不支持分页')
      const reference = videoLink(query), value = await this.video(reference, signal)
      const part = value.pages.find(p => p.page === reference.page)
      if (!part) throw new PlayerError('视频中不存在该分 P')
      this.remember(value.series)
      return { items: [{ ...value.series, defaultEpisodeId: value.series.id + ':' + part.cid }], cursor: null }
    }
    const size = Math.max(1, Math.min(30, pageSize)), key = 'videos:' + JSON.stringify([query, page, size, category])
    const cached = this.pages.get(key)
    if (cached?.until > Date.now()) return cached.value
    let data
    try {
      data = await this.request(query ? 'fetchVideoSearch' : 'fetchVideoIndex', query
        ? { keyword: query, page, category } : { page, pageSize: size, category }, signal)
    } catch (error) {
      const local = this.localSeries({ contentType: 'video' }).filter(row =>
        (!query || row.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())) &&
        (category === 'all' || row.category === category))
      if (!signal?.aborted && !this.context.signal?.aborted && page === 1 && local.length) return { items: local, cursor: null }
      throw error
    }
    let rows = query ? data?.result ?? (Number(data?.numResults) === 0 ? [] : undefined) : data?.list
    if (!Array.isArray(rows)) throw apiError()
    const regional = !query && category !== 'all'
    const total = rows.length
    if (regional) rows = rows.slice((page - 1) * size, page * size)
    const items = rows.filter(row => videoPattern.test(row.bvid || '') && typeof row.title === 'string').slice(0, 40).map(row => ({
      id: 'video:' + row.bvid, title: plain(row.title).slice(0, 320),
      description: plain(row.description || row.desc || '').slice(0, 2000),
      author: plain(row.author || row.owner?.name).slice(0, 80),
      contentType: 'video', category: videoCategory(row.tid || row.typeid),
      episodes: Number(row.videos) || null, coverURL: row.pic?.startsWith('//') ? 'https:' + row.pic : row.pic,
      durationMs: durationMs(row.duration),
    }))
    const more = query ? Number(data.numPages) > page : regional ? page * size < total : data.no_more === false
    const value = { items, cursor: more && items.length ? encodeCursor(this.id, 'videos-v1', scope, page + 1) : null }
    this.pages.set(key, { value, until: Date.now() + 60000 })
    while (this.pages.size > 48) this.pages.delete(this.pages.keys().next().value)
    return value
  }
  async videoEpisodes(id, { cursor, pageSize = 120, signal } = {}) {
    const offset = decodeCursor(cursor, this.id, 'episodes', id) ?? 0
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 2000) throw new PlayerError('分页信息无效')
    const { series, pages } = await this.video({ bvid: id.slice(6) }, signal)
    const items = pages.slice(offset, offset + pageSize).map(p => ({
      id: id + ':' + p.cid, number: p.page, label: plain(p.part || 'P' + p.page).slice(0, 320), codec: '', playable: true,
    }))
    return { series, items, cursor: offset + items.length < pages.length
      ? encodeCursor(this.id, 'episodes', id, offset + items.length) : null }
  }
  async videoPlayback(id, signal) {
    const [kind, bvid, cid, extra] = String(id).split(':')
    if (kind !== 'video' || !videoPattern.test(bvid || '') || !number(cid) || extra !== undefined) throw new PlayerError('视频分 P 编号无效')
    const video = await this.video({ bvid }, signal, true)
    if (!video.pages.some(p => String(p.cid) === cid)) throw new PlayerError('该分 P 不属于当前视频或已下架')
    let data = await this.request('fetchVideoStreamUrl', { avid: video.aid, cid: Number(cid) }, signal)
    if (!data) throw apiError()
    if (preview(data)) throw new PlayerError('B 站仅提供试看，请使用拥有完整观看权益的账号')
    if (drm(data)) throw new PlayerError('该视频需要 DRM 播放授权，当前播放器暂不支持')
    return this.playback(data, true)
  }
  localSeries({ contentType = 'bangumi' } = {}) {
    return this.db.prepare('SELECT body FROM library WHERE body IS NOT NULL ORDER BY added DESC,id DESC LIMIT 48').all()
      .flatMap(row => { try { const item = JSON.parse(row.body); return contentKind(item.id) === contentType ? [item] : [] } catch { return [] } })
  }
  async getSeries(id, { signal } = {}) {
    if (videoId(id)) return (await this.video({ bvid: id.slice(6) }, signal)).series
    if (!number(id)) throw invalidLink()
    return (await this.season({ season_id: 'ss' + id }, signal)).series
  }
  async listEpisodes(id, { cursor, pageSize = 120, signal } = {}) {
    if (videoId(id)) return this.videoEpisodes(id, { cursor, pageSize, signal })
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
    if (String(id).startsWith('video:')) return this.videoPlayback(id, signal)
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
    return this.playback(data)
  }
  playback(data, ordinary = false) {
    const duration = Number(data.timelength) / 1000
    if (!(duration > 0 && duration <= (ordinary ? 86400 : 7200))) throw new PlayerError(ordinary ? '视频时长无效或超过一天限制' : '番剧时长无效或超过两小时限制')
    const locator = track => {
      const urls = [track.baseUrl || track.base_url || track.url, ...(track.backupUrl || track.backup_url || [])].filter(Boolean)
      // Ordinary videos can advertise P2P/IP/nonstandard-port mirrors first.
      // Select a policy-approved CDN rather than rejecting valid backups or
      // relaxing the Host's domain/port boundary.
      const allowed = [...new Set(urls.flatMap(url => {
        try { return [allowedURL(url, bilibiliMediaHosts).href] } catch { return [] }
      }))]
      if (!allowed.length) throw new PlayerError('片源地址不在支持的媒体域名内')
      const segment = track.SegmentBase || track.segment_base
      return { url: allowed[0],
        mime: (track.mimeType || track.mime_type || (track.codecs?.startsWith('mp4a') ? 'audio/mp4' : 'video/mp4')) + '; codecs="' + track.codecs + '"',
        ...(segment ? { initialization: segment.Initialization || segment.initialization,
          indexRange: segment.indexRange || segment.index_range } : {}),
        backupURLs: allowed.slice(1, 4) }
    }
    const audio = (data.dash?.audio || []).filter(track => !drm(track) && /^mp4a\./i.test(track.codecs || ''))
      .sort((a, b) => a.bandwidth - b.bandwidth)[0]
    const authenticated = !!this.auth.cookie()
    const video = (data.dash?.video || []).filter(track => !drm(track) && /^avc[13]\./i.test(track.codecs || '') &&
      ((ordinary && (track.SegmentBase || track.segment_base) && (audio?.SegmentBase || audio?.segment_base)) ||
       (Number(track.bandwidth) + Number(audio?.bandwidth)) * duration / 8 < 240 * 1024 * 1024))
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
    this.seasons.clear(); this.videos.clear(); this.pages.clear(); this.auth.dispose()
    this.database?.close(); this.database = undefined
  }
}
