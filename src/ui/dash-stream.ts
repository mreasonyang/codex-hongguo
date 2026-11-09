import { call } from './api'

type Segment = { asset: string; time: number; duration: number }
type Track = { mime: string; initialization: string; segments: Segment[] }
type Manifest = { version: number; duration: number; tracks: Track[] }
const assetName = /^(?:video|audio)-(?:init\.mp4|\d{5}\.m4s)$/

export function dashStream(video: HTMLVideoElement, episodeId: string, stream: string, raw: string,
  fail: (reason: string) => void, ended: () => void, startPosition = 0) {
  const manifest = JSON.parse(raw) as Manifest
  if (manifest.version !== 1 || !(manifest.duration > 0 && manifest.duration <= 86400) ||
      manifest.tracks?.length !== 2 || manifest.tracks.some(track => !assetName.test(track.initialization) ||
        !MediaSource.isTypeSupported(track.mime) || !track.segments?.length || track.segments.length > 32768 ||
        track.segments.some(s => !assetName.test(s.asset) || !Number.isFinite(s.time) || s.time < 0 ||
          !(s.duration > 0) || s.time + s.duration > manifest.duration + 2)))
    throw Error('当前面板无法处理该番剧的音视频分段')
  const media = new MediaSource(), url = URL.createObjectURL(media)
  let closed = false, pumping = false, again = false, initialized = false, initialPosition = startPosition
  const pending = new Set<() => void>()
  const tracks: { track: Track; buffer: SourceBuffer; loaded: Set<string> }[] = []
  async function asset(name: string) {
    let offset = 0, bytes: Uint8Array<ArrayBuffer> | undefined
    do {
      const part = await call<{ size: number; bytes: string }>('read_panel_chunk', { episodeId, stream, asset: name, offset }, 35000)
      if (closed) return
      if (!Number.isSafeInteger(part.size) || part.size < 1 || part.size > 32 * 1024 * 1024) throw Error()
      bytes ??= new Uint8Array(part.size)
      const value = atob(part.bytes)
      if (bytes.length !== part.size || !value.length || offset + value.length > bytes.length) throw Error()
      for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i)
      offset += value.length
    } while (offset < bytes.length)
    return bytes.buffer
  }
  function update(buffer: SourceBuffer, change: () => void) {
    return new Promise<void>((resolve, reject) => {
      const done = () => finish()
      const error = () => finish(Error())
      function finish(reason?: Error) {
        pending.delete(done)
        buffer.removeEventListener('updateend', done); buffer.removeEventListener('error', error)
        if (reason) reject(reason); else resolve()
      }
      buffer.addEventListener('updateend', done, { once: true }); buffer.addEventListener('error', error, { once: true })
      pending.add(done)
      try { if (closed) finish(); else change() } catch { finish(Error()) }
    })
  }
  async function append(buffer: SourceBuffer, name: string) {
    const bytes = await asset(name)
    if (bytes && !closed) await update(buffer, () => buffer.appendBuffer(bytes))
  }
  async function pumpTrack(item: typeof tracks[number], position: number) {
    const { track, buffer, loaded } = item
    // Keep a small window around the playhead, including after a long-distance
    // seek. Concealing/pausing never starts playback or downloads the whole show.
    const before = Math.max(0, position - 24), after = position + 48
    for (let i = buffer.buffered.length - 1; i >= 0; i--) {
      if (i >= buffer.buffered.length) continue
      const a = buffer.buffered.start(i), b = buffer.buffered.end(i)
      if (b <= before || a >= after) {
        await update(buffer, () => buffer.remove(a, b))
        for (const s of track.segments) if (s.time < b && s.time + s.duration > a) loaded.delete(s.asset)
      } else if (a < before) {
        await update(buffer, () => buffer.remove(a, before))
        for (const s of track.segments) if (s.time < before) loaded.delete(s.asset)
      }
    }
    const nearby = track.segments.filter(s => s.time + s.duration > position && s.time < position + 16)
    for (const s of nearby) {
      if (closed) return
      if (Math.abs((video.currentTime || initialPosition) - position) > 24) { again = true; return }
      if (loaded.has(s.asset)) continue
      await append(buffer, s.asset); loaded.add(s.asset)
    }
  }
  async function pump() {
    if (closed || !initialized) return
    if (pumping) { again = true; return }
    pumping = true
    try {
      do {
        again = false
        const position = video.currentTime || Math.min(initialPosition, manifest.duration - 0.1)
        await Promise.all(tracks.map(item => pumpTrack(item, position)))
        initialPosition = 0
        if (!closed && media.readyState === 'open' && tracks.every(item => item.loaded.has(item.track.segments.at(-1)!.asset)))
          media.endOfStream()
      } while (again && !closed)
    } catch {
      if (!closed) { close(); fail('番剧分段读取失败，请重新点播') }
    } finally { pumping = false }
  }
  const open = async () => {
    try {
      media.duration = manifest.duration
      for (const track of manifest.tracks)
        tracks.push({ track, buffer: media.addSourceBuffer(track.mime), loaded: new Set() })
      await Promise.all(tracks.map(item => append(item.buffer, item.track.initialization)))
      if (closed) return
      initialized = true
      await pump()
    } catch { if (!closed) { close(); fail('当前面板无法处理该番剧的音视频分段') } }
  }
  const refill = () => { if (!video.paused) void pump() }
  const seek = () => { void pump() }
  const finish = () => { if (video.currentTime >= manifest.duration - 1) ended() }
  function close() {
    if (closed) return
    closed = true
    for (const done of pending) done()
    media.removeEventListener('sourceopen', open)
    video.removeEventListener('timeupdate', refill); video.removeEventListener('playing', refill)
    video.removeEventListener('seeking', seek); video.removeEventListener('waiting', refill)
    video.removeEventListener('ended', finish)
    for (const item of tracks) { try { if (item.buffer.updating) item.buffer.abort() } catch { /* Already detached. */ } }
    URL.revokeObjectURL(url)
  }
  media.addEventListener('sourceopen', open, { once: true })
  video.addEventListener('timeupdate', refill); video.addEventListener('playing', refill)
  video.addEventListener('seeking', seek); video.addEventListener('waiting', refill)
  video.addEventListener('ended', finish)
  video.src = url
  return close
}
