import { mkdir, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DashMedia } from './dash-media.mjs'
import { movieIndex, windowRanges } from './mp4-index.mjs'
import { responseBytes } from './sources/network.mjs'
import { runFfmpeg } from './media.mjs'
import { PlayerError } from './errors.mjs'

const MB = 1024 * 1024, seconds = 6, maxIndex = 8 * MB, maxFile = 256 * MB
const invalid = () => new PlayerError('视频索引不完整或暂不支持，请重试')

// CENC MP4 is indexed once, then fetched/decrypted/transcoded only around the
// requested HLS segment. A seek or resume never scans the preceding movie.
export class FileMedia extends DashMedia {
  constructor(root, { run = runFfmpeg, ...options } = {}) { super(join(root, 'file-media'), options); this.run = run }
  prepare(id, resolve, revision, retry, preload) {
    const e = this.entries.get(id)
    if (retry && e?.failedAssets?.size) this.drop(e)
    return super.prepare(id, resolve, revision, retry, preload)
  }
  async build(e, resolve) {
    const descriptor = await resolve(e.abort.signal); this.valid(e)
    const files = descriptor.candidates?.filter(c => c.kind === 'file' && !/bytevc2/i.test(c.codec || ''))
    if (!files?.length) throw invalid()
    e.fetch = descriptor.fetchMedia; e.phase = 'index'; e.format = 'hls'
    let failure
    for (const candidate of files.slice(0, 4)) {
      try {
        const key = candidate.encryption?.key
        if (candidate.encryption && (candidate.encryption.kind !== 'cenc' || !/^[a-f0-9]{32}$/i.test(key || ''))) throw invalid()
        e.track = { url: candidate.url, backupURLs: candidate.backupURLs }; e.key = key; e.header = []; e.probe = []
        let at = 0, count = 0, movie
        while (++count <= 256) {
          this.valid(e)
          const response = await e.fetch(candidate.url, 16, 30000, 0, { offset: at, length: 16 }, e.abort.signal)
          const head = await responseBytes(response.body, 16); this.valid(e)
          const total = response.totalBytes || candidate.size
          if (!Number.isSafeInteger(total) || total < 16 || total > maxFile || head.length !== 16) throw invalid()
          e.totalBytes = total
          let size = head.readUInt32BE(0), headerSize = 8
          if (size === 1) { size = Number(head.readBigUInt64BE(8)); headerSize = 16 }
          if (size === 0) size = total - at
          if (!Number.isSafeInteger(size) || size < headerSize || at + size > total) throw invalid()
          const type = head.toString('ascii', 4, 8)
          if (['ftyp', 'moov'].includes(type)) {
            if (size > maxIndex || e.header.reduce((n, r) => n + r.bytes.length, size) > maxIndex) throw invalid()
            const bytes = await this.range(e, e.track, { offset: at, length: size })
            e.header.push({ offset: at, bytes })
            if (type === 'moov') movie = bytes
          } else e.header.push({ offset: at, bytes: head.subarray(0, headerSize) })
          at += size
          if (at === total) break
          if (at > total - 16) throw invalid()
        }
        if (!movie || count > 256) throw invalid()
        e.index = movieIndex(movie, e.totalBytes); e.durationMs = e.index.durationMs
        const duration = e.durationMs / 1000, manifest = ['#EXTM3U', '#EXT-X-VERSION:3',
          '#EXT-X-TARGETDURATION:' + seconds, '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-INDEPENDENT-SEGMENTS']
        e.assets.clear()
        for (let start = 0, n = 0; start < duration; start += seconds, n++) {
          const length = Math.min(seconds, duration - start), asset = 'seg' + String(n).padStart(5, '0') + '.ts'
          e.assets.set(asset, { start, duration: length })
          manifest.push('#EXTINF:' + length.toFixed(6) + ',', asset)
        }
        manifest.push('#EXT-X-ENDLIST'); this.valid(e)
        e.manifest = manifest.join('\n') + '\n'
        // A resumed episode starts at its saved position. Explicit next-episode
        // preloading warms just its first fragment, never the complete movie.
        if (e.preload) void this.asset(e, 'seg00000.ts').catch(() => {})
        return
      } catch (error) { failure = error; e.assets.clear() }
    }
    e.key = undefined
    throw failure
  }
  async asset(e, asset) {
    const cached = e.files.get(asset)
    if (cached && (await stat(join(e.dir, asset)).catch(() => null))?.size === cached.size) {
      cached.used = Date.now(); return cached.size
    }
    if (cached) { e.files.delete(asset); this.bytes -= cached.size }
    if (e.jobs.has(asset)) return e.jobs.get(asset)
    const segment = e.assets.get(asset)
    if (!segment || e.jobs.size >= 2) throw new PlayerError('播放分段请求无效')
    const job = this.render(e, asset, segment).then(size => {
      e.failedAssets?.delete(asset)
      return size
    }).catch(error => {
      if (!e.abort.signal.aborted && this.entries.get(e.id) === e && e.revision === e.currentRevision())
        (e.failedAssets ??= new Set()).add(asset)
      throw error
    }).finally(() => e.jobs.delete(asset))
    e.jobs.set(asset, job); return job
  }
  async render(e, asset, segment) {
    const dir = join(e.dir, asset + '.work'), inputName = 'input.mp4'
    try {
      this.valid(e)
      // Probe data is small and shared, not the complete encrypted file.
      e.probeJob ??= Promise.all(windowRanges(e.index, 0, 2).map(async range => ({ ...range,
        bytes: await this.range(e, e.track, range) }))).catch(error => { e.probeJob = null; throw error })
      const probe = await e.probeJob; this.valid(e)
      await mkdir(dir, { mode: 0o700 })
      const input = await open(join(dir, inputName), 'wx', 0o600)
      try {
        await input.truncate(e.totalBytes)
        for (const r of [...e.header, ...probe]) await input.write(r.bytes, 0, r.bytes.length, r.offset)
        for (const range of windowRanges(e.index, segment.start, segment.start + segment.duration)) {
          const bytes = await this.range(e, e.track, range); this.valid(e)
          await input.write(bytes, 0, bytes.length, range.offset)
        }
      } finally { await input.close() }
      this.valid(e)
      // The key is passed only through stdin. argv has no key, URL or ticket.
      const control = "ffconcat version 1.0\nfile 'file:" + inputName + "'\nduration " + (e.durationMs / 1000) + '\n' +
        (e.key ? 'option decryption_key ' + e.key + '\n' : '')
      await this.run(['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'concat,mov',
        '-analyzeduration', '1000000', '-probesize', '65536', '-ss', String(segment.start),
        '-safe', '0', '-f', 'concat', '-i', 'pipe:0', '-t', String(segment.duration),
        '-map', '0:v:0', '-map', '0:a:0?', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2,format=yuv420p',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-bf', '0', '-c:a', 'aac',
        '-output_ts_offset', String(segment.start), '-muxdelay', '0', '-f', 'mpegts', 'output.ts'],
      control, false, dir, { signal: e.abort.signal })
      this.valid(e)
      const bytes = await readFile(join(dir, 'output.ts'))
      if (!bytes.length || bytes.length > 32 * MB) throw invalid()
      this.evict(bytes.length)
      await writeFile(join(e.dir, asset), bytes, { mode: 0o600 }); this.valid(e)
      e.files.set(asset, { size: bytes.length, used: Date.now() }); this.bytes += bytes.length
      return bytes.length
    } finally { await rm(dir, { recursive: true, force: true }) }
  }
  drop(e) {
    // Wait for active FFmpeg/file handles before deleting on Windows.
    e.abort.abort(); e.key = undefined
    if (this.entries.get(e.id) === e) this.entries.delete(e.id)
    for (const cached of e.files.values()) this.bytes -= cached.size
    e.files.clear()
    return Promise.allSettled([e.job, ...e.jobs.values()]).then(() => rm(e.dir, { recursive: true, force: true })).catch(() => {})
  }
  close() { return Promise.allSettled([...this.entries.values()].map(e => this.drop(e))) }
}
