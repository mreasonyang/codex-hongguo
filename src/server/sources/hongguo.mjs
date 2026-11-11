import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { projectRoot } from '../paths.mjs'
import { sourceCall, encodeCursor, decodeCursor, filePlayback } from './contracts.mjs'
import { cdn, responseBytes } from './network.mjs'
import { PlayerError } from '../errors.mjs'

export class HongguoSource {
  id = 'hongguo'
  constructor(root) { this.root = root; this.fetchMedia = cdn }
  async sdkCall(method, ...args) {
    this.client ??= import(pathToFileURL(join(projectRoot, 'dist/vendor/openhongguo/index.js')).href)
      .then(mod => mod.createClient({ profile: process.env.HONGGUO_PROFILE_PATH || join(this.root, 'device', 'anonymous.json'),
        timeoutMs: 10000, retryAttempts: 2, deviceResets: 2 }))
      .catch(error => { this.client = null; throw error })
    return (await this.client)[method](...args)
  }
  series(row) {
    return { id: String(row.id), title: row.title, description: row.description || '',
      episodes: row.episode_count || null, coverURL: row.cover_url }
  }
  async listSeries({ query = '', cursor, pageSize = 16, signal } = {}) {
    const state = decodeCursor(cursor, this.id, 'list', query)
    const page = await sourceCall(() => query
      ? this.sdkCall('search', query, { cursor: state, pageSize, filters: ['content_type_short_play'] })
      : this.sdkCall('discover', { cursor: state }), signal)
    return { items: (page.items || []).filter(s => /^\d{1,32}$/.test(s.id)).map(s => this.series(s)),
      cursor: page.has_more ? encodeCursor(this.id, 'list', query, page.cursor) : null }
  }
  async getSeries(id, { signal } = {}) { return this.series(await sourceCall(() => this.sdkCall('getSeries', id), signal)) }
  async listEpisodes(id, { cursor, pageSize = 120, signal } = {}) {
    const state = decodeCursor(cursor, this.id, 'episodes', id)
    const page = await sourceCall(() => this.sdkCall('listEpisodes', id, { cursor: state, pageSize }), signal)
    return { items: (page.items || []).filter(e => /^\d{1,32}$/.test(e.id)).map(e => ({
      id: String(e.id), number: e.number, label: e.title || '第 ' + e.number + ' 集', codec: '', playable: e.playable !== false,
    })), cursor: page.has_more ? encodeCursor(this.id, 'episodes', id, page.cursor) : null }
  }
  async getCover(id, { url, signal } = {}) {
    url ||= (await this.getSeries(id, { signal })).coverURL
    if (!url) return null
    const { body } = await cdn(url, 3 * 1024 * 1024, 7000)
    return { bytes: await responseBytes(body, 3 * 1024 * 1024) }
  }
  resolvePlayback(id, { signal } = {}) {
    return sourceCall(async () => {
      const compatible = result => (result.playback?.streams || []).some(s => s.url && !/bytevc2/i.test(s.codec || ''))
      let result = await this.sdkCall('resolvePlayback', id)
      // The service can issue a ByteVC2-only model even though this player uses
      // standard codecs. Refresh once without explicitly resetting the device.
      if (!compatible(result) && result.playback?.streams?.some(s => /bytevc2/i.test(s.codec || ''))) {
        if (signal?.aborted) throw new PlayerError('请求已取消', 499)
        result = await this.sdkCall('resolvePlayback', id)
        if (!compatible(result)) {
          const error = new PlayerError('该集暂未提供兼容编码，请稍后重试', 503)
          error.code = 'UNSUPPORTED_CODEC'
          throw error
        }
      }
      return { ...filePlayback(result), fetchMedia: this.fetchMedia }
    }, signal)
  }
}
