import { randomUUID } from 'node:crypto'
import { mkdirSync, rmSync, readdirSync, statSync, utimesSync } from 'node:fs'
import { open, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PlayerError } from './errors.mjs'
import { responseBytes } from './sources/network.mjs'

const MB = 1024 * 1024, maxAsset = 32 * MB, idle = 10 * 60000
const invalid = () => new PlayerError('片源分段索引无效，请重新点播')
export function byteRange(value, maximum = MB) {
  const match = /^(\d+)-(\d+)$/.exec(String(value))
  if (!match) throw invalid()
  const offset = Number(match[1]), end = Number(match[2]), length = end - offset + 1
  if (![offset, end, length].every(Number.isSafeInteger) || offset < 0 || length < 1 || length > maximum) throw invalid()
  return { offset, length }
}

// ISO/IEC 14496-12 SIDX. All offsets are absolute in the original MP4, kept in
// the Host. The panel receives only opaque, generated fragment names/timestamps.
export function sidxSegments(bytes, offset, durationMs) {
  try {
    let box = 0
    while (box + 8 <= bytes.length) {
      const size = bytes.readUInt32BE(box)
      if (size < 8 || box + size > bytes.length) throw invalid()
      if (bytes.toString('ascii', box + 4, box + 8) !== 'sidx') { box += size; continue }
      const version = bytes[box + 8], scale = bytes.readUInt32BE(box + 16)
      if (version > 1 || !scale) throw invalid()
      let p = box + 20
      const readTime = () => {
        const n = version ? Number(bytes.readBigUInt64BE(p)) : bytes.readUInt32BE(p)
        p += version ? 8 : 4
        if (!Number.isSafeInteger(n)) throw invalid()
        return n
      }
      let time = readTime() / scale
      let position = offset + box + size + readTime()
      const count = bytes.readUInt16BE(p + 2); p += 4
      if (!count || count > 7200 || p + count * 12 !== box + size) throw invalid()
      const result = []
      for (let i = 0; i < count; i++, p += 12) {
        const reference = bytes.readUInt32BE(p), length = reference & 0x7fffffff
        const duration = bytes.readUInt32BE(p + 4) / scale
        if (reference >>> 31 || !length || length > maxAsset || !duration ||
            !Number.isSafeInteger(position + length) || time + duration > durationMs / 1000 + 2) throw invalid()
        result.push({ offset: position, length, time, duration })
        position += length; time += duration
      }
      if (position - result[0].offset > 256 * MB || Math.abs(time - durationMs / 1000) > 2) throw invalid()
      return result
    }
  } catch { throw invalid() }
  throw invalid()
}

export class DashMedia {
  constructor(root, { maxBytes = 128 * MB } = {}) {
    this.root = join(root, 'dash-media'); this.entries = new Map(); this.bytes = 0; this.maxBytes = maxBytes
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    for (const item of readdirSync(this.root, { withFileTypes: true })) {
      const dir = join(this.root, item.name)
      if (item.isDirectory() && /^[0-9a-f-]{36}$/.test(item.name) &&
          Date.now() - statSync(dir, { throwIfNoEntry: false })?.mtimeMs > 86400000)
        rmSync(dir, { recursive: true, force: true })
    }
  }
  drop(e) {
    if (this.entries.get(e.id) === e) this.entries.delete(e.id)
    e.abort.abort()
    for (const cached of e.files.values()) this.bytes -= cached.size
    e.files.clear()
    rmSync(e.dir, { recursive: true, force: true })
  }
  sweep() {
    for (const e of this.entries.values()) if (!e.viewers.size && Date.now() - e.used > idle) this.drop(e)
  }
  prepare(id, resolve, revision, retry, preload) {
    this.sweep()
    const current = revision()
    let e = this.entries.get(id)
    if (e && (e.revision !== current || (e.error && retry))) { this.drop(e); e = undefined }
    if (!e) {
      if (this.entries.size >= 4) {
        const cold = [...this.entries.values()].filter(row => !row.viewers.size && (!preload || !row.pending))
          .sort((a, b) => a.used - b.used)[0]
        if (!cold) throw new PlayerError('播放器正忙，请稍后重试')
        this.drop(cold)
      }
      const stream = randomUUID(), dir = join(this.root, stream)
      mkdirSync(dir, { mode: 0o700 })
      e = { id, stream, dir, revision: current, currentRevision: revision, abort: new AbortController(),
        used: Date.now(), viewers: new Set(), files: new Map(), jobs: new Map(), assets: new Map(), pending: true, phase: 'source', preload }
      this.entries.set(id, e)
      e.job = this.build(e, resolve).catch(error => {
        e.error = error instanceof PlayerError ? error.message : '播放分段暂不可达，请重试'
      }).finally(() => { e.pending = false })
    }
    e.used = Date.now()
    if (e.error) return { status: 'error', reason: e.error }
    if (e.fallback) return { status: 'fallback' }
    if (!e.manifest) return { status: 'preparing', phase: e.phase }
    return { status: 'ready', format: 'dash', stream: e.stream, manifest: e.manifest,
      codec: 'h264', durationMs: e.durationMs }
  }
  valid(e) {
    if (e.abort.signal.aborted || this.entries.get(e.id) !== e || e.revision !== e.currentRevision())
      throw new PlayerError('该播放分段已失效，请重新点播', 404)
  }
  async range(e, track, range) {
    let failure
    for (const url of [...new Set([track.url, ...(track.backupURLs || [])])].slice(0, 4)) {
      this.valid(e)
      try {
        const response = await e.fetch(url, range.length, 30000, 0, range, e.abort.signal)
        const bytes = await responseBytes(response.body, range.length)
        this.valid(e)
        if (bytes.length !== range.length) throw invalid()
        return bytes
      } catch (error) { failure = error }
    }
    throw failure instanceof PlayerError ? failure : new PlayerError('播放分段暂不可达，请重试')
  }
  async build(e, resolve) {
    const descriptor = await resolve()
    this.valid(e)
    const candidates = descriptor.candidates?.filter(row => row.kind === 'tracks' && row.video?.indexRange && row.audio?.indexRange)
    if (!candidates?.length) { e.fallback = true; return }
    if (!(descriptor.durationMs > 0 && descriptor.durationMs <= 7200000)) throw invalid()
    e.durationMs = descriptor.durationMs; e.fetch = descriptor.fetchMedia; e.phase = 'index'
    let failure
    for (const candidate of candidates.slice(0, 2)) {
      try {
        const tracks = await Promise.all(['video', 'audio'].map(async name => {
          const track = candidate[name]
          if (!/^(?:video\/mp4; codecs="avc[13]\.[\da-f]{6}"|audio\/mp4; codecs="mp4a\.40\.\d+")$/i.test(track.mime)) throw invalid()
          const initialization = byteRange(track.initialization), index = byteRange(track.indexRange)
          if (initialization.offset !== 0 || initialization.offset + initialization.length > index.offset) throw invalid()
          const segments = sidxSegments(await this.range(e, track, index), index.offset, e.durationMs)
          const init = name + '-init.mp4'
          return { name, track, initialization, segments, init }
        }))
        this.valid(e)
        if (tracks.reduce((sum, track) => sum + track.initialization.length +
          track.segments.reduce((n, segment) => n + segment.length, 0), 0) > 256 * MB)
          throw new PlayerError('素材超过大小限制')
        const manifest = { version: 1, duration: e.durationMs / 1000, tracks: tracks.map(({ name, track, initialization, segments, init }) => {
          e.assets.set(init, { track, range: initialization })
          return { mime: track.mime, initialization: init, segments: segments.map((segment, i) => {
            const asset = name + '-' + String(i).padStart(5, '0') + '.m4s'
            e.assets.set(asset, { track, range: { offset: segment.offset, length: segment.length } })
            return { asset, time: segment.time, duration: segment.duration }
          }) }
        }) }
        e.manifest = JSON.stringify(manifest)
        if (e.manifest.length > 1024 * 1024) throw invalid()
        if (e.preload) void Promise.all(manifest.tracks.map(async track => {
          for (const asset of [track.initialization, ...track.segments.slice(0, 2).map(segment => segment.asset)])
            await this.asset(e, asset)
        })).catch(() => {})
        return
      } catch (error) { failure = error; e.assets.clear() }
    }
    throw failure
  }
  owns(id, stream) { return this.entries.get(id)?.stream === stream }
  entry(id, stream) {
    const e = this.entries.get(id)
    if (!e || e.stream !== stream || e.error || !e.manifest) throw new PlayerError('该播放分段已失效，请重新点播', 404)
    this.valid(e); e.used = Date.now()
    if (!e.touched || e.used - e.touched > 60000) {
      mkdirSync(e.dir, { recursive: true, mode: 0o700 })
      utimesSync(e.dir, new Date(e.used), new Date(e.used)); e.touched = e.used
    }
    return e
  }
  manifest(id, stream) { return { manifest: this.entry(id, stream).manifest } }
  evict(size) {
    const files = [...this.entries.values()].flatMap(e => [...e.files].map(([asset, f]) => ({ e, asset, ...f })))
      .sort((a, b) => a.used - b.used)
    for (const f of files) {
      if (this.bytes + size <= this.maxBytes) break
      f.e.files.delete(f.asset); this.bytes -= f.size; rmSync(join(f.e.dir, f.asset), { force: true })
    }
  }
  async asset(e, asset) {
    const cached = e.files.get(asset)
    if (cached && statSync(join(e.dir, asset), { throwIfNoEntry: false })?.size === cached.size) {
      cached.used = Date.now(); return cached.size
    }
    if (cached) { e.files.delete(asset); this.bytes -= cached.size }
    if (e.jobs.has(asset)) return e.jobs.get(asset)
    const descriptor = e.assets.get(asset)
    if (!descriptor || e.jobs.size >= 4) throw new PlayerError('播放分段请求无效')
    const job = (async () => {
      const bytes = await this.range(e, descriptor.track, descriptor.range)
      this.valid(e)
      mkdirSync(e.dir, { recursive: true, mode: 0o700 })
      await writeFile(join(e.dir, asset), bytes, { mode: 0o600 })
      this.valid(e)
      this.evict(bytes.length)
      e.files.set(asset, { size: bytes.length, used: Date.now() }); this.bytes += bytes.length
      return bytes.length
    })().finally(() => e.jobs.delete(asset))
    e.jobs.set(asset, job)
    return job
  }
  async chunk(id, stream, asset, offset) {
    const e = this.entry(id, stream)
    if (!e.assets.has(asset) || !Number.isSafeInteger(offset) || offset < 0) throw new PlayerError('播放分段请求无效')
    const size = await this.asset(e, asset)
    if (offset >= size) throw new PlayerError('分段超出支持范围')
    const file = await open(join(e.dir, asset), 'r')
    try {
      const bytes = Buffer.alloc(Math.min(192 * 1024, size - offset))
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset)
      this.valid(e)
      if (bytesRead !== bytes.length) throw invalid()
      return { size, bytes: bytes.toString('base64') }
    } finally { await file.close() }
  }
  pin(id, viewer) { this.entries.get(id)?.viewers.add(viewer) }
  unpin(id, viewer) { this.entries.get(id)?.viewers.delete(viewer) }
  close() { for (const e of this.entries.values()) this.drop(e) }
}
