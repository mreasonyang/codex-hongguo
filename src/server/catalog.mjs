import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { projectRoot } from './paths.mjs'
import { PlayerError } from './errors.mjs'
import { cdn, hasFfmpeg, MediaCache, runFfmpeg } from './media.mjs'
import { ensureFfmpeg } from '../runtime/ffmpeg-runtime.mjs'
import { createHash } from 'node:crypto'
import { SharedCatalogCache } from './catalog-cache.mjs'

import { PanelMedia } from './panel-media.mjs'

function sdkError(e) {
  const labels = {
    ANONYMOUS_LIMITED: '上游暂时限制匿名播放',
    RATE_LIMITED: '请求过于频繁',
    AUTHENTICATION_REQUIRED: '片源需要登录',
    CONTENT_UNAVAILABLE: '片源暂不可用',
  }
  return new PlayerError((labels[e?.code] || '红果片源暂时不可达') + '，请稍后重试', 503)
}
export class Catalog {
  constructor(store) {
    this.store = store
    this.ffmpeg = hasFfmpeg()
    this.covers = new Map()
    this.coverLookups = new Map()
    this.metadata = new SharedCatalogCache(store)
    this.firstPages = new Map()
    this.coverJobs = 0
    void this.prepareMediaRuntime().catch(() => {})
  }
  prepareMediaRuntime() {
    this.preparingRuntime ??= ensureFfmpeg().then(() => { this.ffmpeg = true }).catch(error => {
      this.ffmpeg = false
      throw error
    }).finally(() => { this.preparingRuntime = null })
    return this.preparingRuntime
  }
  async sdk() {
    this.client ??= import(pathToFileURL(join(projectRoot, 'dist/vendor/openhongguo/index.js')).href)
      .then((mod) =>
        mod.createClient({
          profile: process.env.HONGGUO_PROFILE_PATH || join(this.store.root, 'device', 'anonymous.json'),
          timeoutMs: 10000,
          retryAttempts: 2,
          deviceResets: 2,
        }),
      )
      .catch((e) => {
        this.client = null
        throw sdkError(e)
      })
    return this.client
  }
  async sdkCall(method, ...args) {
    try {
      return await (await this.sdk())[method](...args)
    } catch (e) {
      throw sdkError(e)
    }
  }
  async list({ query = '', cursor, preview } = {}) {
    if (!query) return { items: await this.recommendations(preview), cursor: null }
    const page = await this.sdkCall('search', query, {
      cursor,
      pageSize: 16,
      filters: ['content_type_short_play'],
    })
    return { items: this.rows(page, true), cursor: page.has_more ? page.cursor || null : null }
  }
  async recommendations(preview = false) {
    const terms = this.store.preferences().searchTerms
    const key = 'feed:' + createHash('sha256').update(JSON.stringify(terms)).digest('hex')
    const cached = this.store.catalogCache(key)?.value
    const titles = preview && !cached ? this.store.waitingFeed(true) : []
    const refresh = this.metadata.get(key, async () => {
      const firstPage = Promise.withResolvers()
      this.firstPages.set(key, firstPage.promise)
      try {
        const rows = await this.collectFeed(firstPage.resolve, terms)
        if (!rows.length) throw new PlayerError('红果片源暂时不可达，请稍后重试', 503)
        const covered = rows.filter(row => row.hasCover)
        return { items: (covered.length >= 12 ? covered : rows).slice(0, 48),
          titles: rows.map(({ id, title }) => ({ id, title })),
          covers: rows.flatMap(({ id }) => this.covers.get(id)?.url ? [[id, this.covers.get(id).url]] : []) }
      } finally { this.firstPages.delete(key) }
    }, { feed: true }).then(value => this.feedItems(value))
    if (preview && (cached || titles.length)) {
      void refresh.catch(() => {})
      return cached ? this.feedItems(cached) : titles
    }
    const first = this.firstPages.get(key)
    return preview && first ? Promise.race([first, refresh]) : refresh
  }
  feedItems(value) {
    for (const [id, url] of value.covers) {
      if (this.covers.get(id)?.url !== url) this.covers.set(id, { url })
    }
    while (this.covers.size > 160) this.covers.delete(this.covers.keys().next().value)
    return value.items
  }
  async waitingRecommendations() {
    const cached = this.store.waitingFeed()
    if (cached.length) return cached
    const previous = this.store.waitingFeed(true)
    const refresh = this.recommendations()
    if (previous.length) {
      void refresh.catch(() => {})
      return previous
    }
    await refresh
    return this.store.waitingFeed(true)
  }
  async collectFeed(onFirstPage, terms = this.store.preferences().searchTerms) {
    const rows = new Map(),
      seen = new Set()
    const merge = (page) => {
      const wasEmpty = !rows.size
      for (const row of this.rows(page))
        if (!rows.has(row.id) || (!rows.get(row.id).hasCover && row.hasCover)) rows.set(row.id, row)
      if (wasEmpty && rows.size) onFirstPage([...rows.values()])
    }
    let cursor, lastError
    for (let i = 0; i < 6 && rows.size < 48; i++) {
      try {
        const page = await this.sdkCall('discover', { cursor })
        merge(page)
        cursor = page.has_more && page.cursor
        if (!cursor || seen.has(cursor)) break
        seen.add(cursor)
      } catch (e) {
        lastError = e
        break
      }
    }
    for (const term of terms) {
      if (rows.size >= 24) break
      try {
        merge(await this.sdkCall('search', term, { filters: ['content_type_short_play'] }))
      } catch (e) {
        lastError = e
      }
    }
    if (!rows.size && lastError) throw lastError
    return [...rows.values()]
  }
  rows(page, lookupCover = false) {
    const items = (page.items || [])
      .filter((s) => /^\d{1,32}$/.test(s.id))
      .map((s) => {
        const id = 'hg-' + s.id
        if (s.cover_url && this.covers.get(id)?.url !== s.cover_url) this.covers.set(id, { url: s.cover_url })
        return {
          id,
          title: s.title,
          description: s.description || '',
          episodes: s.episode_count || null,
          hasCover: !!this.covers.get(id)?.url,
          ...(lookupCover ? { lookupCover: true } : {}),
        }
      })
    while (this.covers.size > 160) this.covers.delete(this.covers.keys().next().value)
    return items
  }
  async cover(id) {
    if (!this.ffmpeg) return { cover: null }
    const entry = this.covers.get(id)
    if (entry?.cover !== undefined) return { cover: entry.cover }
    if (this.coverLookups.has(id)) return this.coverLookups.get(id)
    if (this.coverJobs >= 3) return { cover: null }
    this.coverJobs++
    const job = this.loadCover(id).finally(() => {
      this.coverJobs--
      this.coverLookups.delete(id)
    })
    this.coverLookups.set(id, job)
    return job
  }
  async loadCover(id) {
    let entry = this.covers.get(id)
    try {
      if (!entry?.url) {
        const detail = await this.sdkCall('getSeries', id.slice(3))
        if (!detail?.cover_url) return { cover: null }
        entry = { url: detail.cover_url }
        this.covers.set(id, entry)
        while (this.covers.size > 160) this.covers.delete(this.covers.keys().next().value)
      }
      const { body, limit } = await cdn(entry.url, 3 * 1024 * 1024, 7000)
      const chunks = []
      await pipeline(
        body,
        limit,
        new Writable({
          write(chunk, enc, next) {
            chunks.push(chunk)
            next()
          },
        }),
      )
      const jpeg = await runFfmpeg(
        [
          '-protocol_whitelist',
          'pipe',
          '-i',
          'pipe:0',
          '-vf',
          'scale=240:320:force_original_aspect_ratio=decrease',
          '-frames:v',
          '1',
          '-f',
          'image2pipe',
          '-c:v',
          'mjpeg',
          'pipe:1',
        ],
        Buffer.concat(chunks),
        true,
      )
      entry.cover = 'data:image/jpeg;base64,' + jpeg.toString('base64')
    } catch {
      return { cover: null }
    }
    return { cover: entry.cover }
  }
  async episodes({ seriesId, cursor }) {
    const key = 'episodes:' + JSON.stringify([seriesId, cursor ?? null])
    const page = await this.metadata.get(key, () => this.loadEpisodes(seriesId, cursor))
    return { ...page, items: page.items.map(ep => ({ ...ep, playable: ep.playable && this.ffmpeg })) }
  }
  async loadEpisodes(seriesId, cursor) {
    const page = await this.sdkCall('listEpisodes', seriesId.slice(3), { cursor, pageSize: 120 })
    return {
      items: (page.items || [])
        .filter((ep) => /^\d{1,32}$/.test(ep.id))
        .map((ep) => ({
          id: 'hg-' + ep.id,
          number: ep.number,
          label: ep.title || '第 ' + ep.number + ' 集',
          codec: '',
          playable: ep.playable !== false,
        })),
      cursor: page.has_more ? page.cursor || null : null,
    }
  }
  async nextEpisode(seriesId, episodeId) {
    let cursor, found = false
    const seen = new Set(), episodes = new Set()
    do {
      const page = await this.episodes({ seriesId, cursor })
      for (const ep of page.items) {
        if (episodes.has(ep.id)) continue
        episodes.add(ep.id)
        if (ep.id === episodeId) found = true
        else if (found && ep.playable) {
          const [progress] = this.store.history(seriesId, ep.id)
          if (!progress || progress.positionMs < progress.durationMs)
            return { episodeId: ep.id, kind: progress ? 'resume' : 'next' }
        }
      }
      cursor = page.cursor
      if (seen.has(cursor)) break
      seen.add(cursor)
    } while (cursor)
    return null
  }
  prepare(id, browser, retry, preload = false) {
    if (!this.ffmpeg) {
      void this.prepareMediaRuntime().catch(() => {})
      return { status: 'preparing' }
    }
    this.cache ??= new MediaCache(this.store, (ep) => this.sdkCall('resolvePlayback', ep))
    const result = this.cache.prepare(id, retry)
    if (result.status !== 'ready') return result
    if (browser) return { ...result, src: 'media/' + id }
    this.panelMedia ??= new PanelMedia(this.store.root)
    return { ...result, ...this.panelMedia.prepare(id, this.cache.path(id), retry, result.codec, preload) }
  }
}
