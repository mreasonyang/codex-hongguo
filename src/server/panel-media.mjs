import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync } from 'node:fs'
import { open, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { runFfmpeg } from './media.mjs'
import { PlayerError } from './errors.mjs'
import { mp4DurationMs } from './mp4-duration.mjs'
import { DashMedia } from './dash-media.mjs'
import { FileMedia } from './file-media.mjs'

const idle = 10 * 60_000
const chunkSize = 192 * 1024
const segmentSeconds = 2
const assetName = /^(?:init\.mp4|seg[0-9]{5}\.m4s)$/
const hardwareEncoders = {
  darwin: ['h264_videotoolbox'],
  win32: ['h264_nvenc', 'h264_qsv', 'h264_amf'],
  linux: ['h264_nvenc', 'h264_qsv', 'h264_vaapi', 'h264_v4l2m2m'],
}
const hlsOutput = [
  '-f', 'hls', '-hls_time', String(segmentSeconds), '-hls_list_size', '0', '-hls_segment_type', 'fmp4',
  '-hls_playlist_type', 'event', '-hls_segment_filename', 'seg%05d.m4s', 'index.m3u8',
]

async function mappedCodecs(run, input) {
  // A zero-frame streamcopy writes just the mapped track headers with the configured FFmpeg.
  const header = await run(
    [...input, '-c', 'copy', '-frames:v', '0', '-frames:a', '0', '-f', 'framehash', 'pipe:1'],
    null, true,
  )
  const text = header.toString('utf8')
  const video = /^#codec_id 0: (\S+)/m.exec(text)?.[1]
  if (!video) throw Error('Missing video stream')
  return { video, audio: /^#codec_id 1: (\S+)/m.exec(text)?.[1] }
}

function h264Options(encoder, audioEncoder) {
  const software = encoder === 'libx264'
  const filter = 'pad=ceil(iw/2)*2:ceil(ih/2)*2,format=' + (software ? 'yuv420p' : 'nv12')
  return [
    '-vf', encoder === 'h264_vaapi' ? filter + ',hwupload' : filter,
    '-c:v', encoder, '-tag:v', 'avc1', '-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`,
    ...(software ? ['-preset', 'veryfast', '-crf', '22'] : ['-b:v', '3M']),
    ...(encoder === 'h264_videotoolbox' ? ['-allow_sw', '0'] : []),
    '-c:a', audioEncoder,
  ]
}

// Only generated local filenames are exposed to a panel. No CDN locator or
// media credential crosses the app bridge. Different panels can share preparation.
export class PanelMedia {
  constructor(root, run = runFfmpeg) {
    this.root = join(root, 'panel-media')
    this.run = run
    this.entries = new Map()
    this.remote = new DashMedia(root)
    this.file = new FileMedia(root)
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    for (const item of readdirSync(this.root, { withFileTypes: true })) {
      const dir = join(this.root, item.name)
      if (
        item.isDirectory() &&
        /^[0-9a-f-]{36}$/.test(item.name) &&
        Date.now() - statSync(dir, { throwIfNoEntry: false })?.mtimeMs > 86400000
      )
        rmSync(dir, { recursive: true, force: true })
    }
    this.timer = setInterval(() => this.sweep(), idle).unref()
  }
  drop(e) {
    this.entries.delete(e.id)
    rmSync(e.dir, { recursive: true, force: true })
  }
  sweep() {
    this.remote.sweep()
    this.file.sweep()
    for (const e of this.entries.values()) if (!e.pending && Date.now() - e.used > idle) this.drop(e)
  }
  touch(e) {
    const now = Date.now()
    if (now - (e.touched || 0) > 60000) {
      utimesSync(e.dir, new Date(now), new Date(now))
      e.touched = now
    }
    e.used = now
  }
  prepare(id, file, retry, sourceCodec, preload = false) {
    this.sweep()
    let e = this.entries.get(id)
    if (e?.error && retry) {
      this.drop(e)
      e = null
    }
    if (!e) {
      if (this.entries.size >= 4) {
        const cold = [...this.entries.values()]
          .filter((e) => !e.pending && (!e.viewers.size || (!preload && Date.now() - e.used > 30000)))
          .sort((a, b) => a.used - b.used)[0]
        if (!cold) throw new PlayerError('侧栏播放器正忙，请稍后重试或使用分屏')
        this.drop(cold)
      }
      const stream = randomUUID(),
        dir = join(this.root, stream)
      mkdirSync(dir, { mode: 0o700 })
      e = { id, dir, stream, used: Date.now(), pending: true, viewers: new Set() }
      this.entries.set(id, e)
      e.job = this.build(e, file, sourceCodec)
        .catch(() => {
          e.error = true
        })
        .finally(() => {
          e.pending = false
        })
    }
    this.touch(e)
    if (e.error) throw new PlayerError('侧栏分段准备失败，可使用同窗分屏')
    if (e.pending && (!e.durationMs || !this.snapshot(e))) return { status: 'preparing' }
    e.exposed = true
    return { status: 'ready', stream: e.stream, manifest: e.manifest, codec: e.codec, durationMs: e.durationMs }
  }
  snapshot(e) {
    try {
      const path = join(e.dir, 'index.m3u8')
      if (statSync(path).size > 256 * 1024) throw Error('playlist limit')
      const manifest = readFileSync(path, 'utf8')
      const fragments = manifest.match(/#EXTINF:/g)?.length || 0
      if (!fragments || (fragments < 2 && !manifest.includes('#EXT-X-ENDLIST'))) return false
      e.manifest = manifest
      return true
    } catch (error) {
      if (error.code === 'ENOENT') return false
      throw new PlayerError('侧栏分段准备失败，可使用同窗分屏')
    }
  }
  manifest(id, stream) {
    if (this.file.owns(id, stream)) return this.file.manifest(id, stream)
    if (this.remote.owns(id, stream)) return this.remote.manifest(id, stream)
    const e = this.entries.get(id)
    if (!e || e.stream !== stream || e.error || !e.manifest)
      throw new PlayerError('该播放分段已失效，请重新点播', 404)
    if (e.pending) this.snapshot(e)
    this.touch(e)
    return { manifest: e.manifest }
  }
  async build(e, file, sourceCodec) {
    const input = ['-protocol_whitelist', 'file', '-f', 'mov', '-i', file, '-map', '0:v:0', '-map', '0:a:0?']
    const [tracks, durationMs] = await Promise.all([mappedCodecs(this.run, input), mp4DurationMs(file)])
    e.durationMs = durationMs
    const audioEncoder = tracks.audio && tracks.audio !== 'aac' ? 'aac' : 'copy'
    const transcodeVideo = tracks.video === 'hevc' || /bytevc1|hevc|h\.?265|hvc1|hev1/i.test(sourceCodec ?? '')
    e.codec = transcodeVideo ? 'h264' : tracks.video
    if (transcodeVideo) {
      for (const encoder of [...(hardwareEncoders[process.platform] ?? []), 'libx264']) {
        const device = encoder === 'h264_vaapi'
          ? ['-init_hw_device', 'vaapi=panel', '-filter_hw_device', 'panel'] : []
        try {
          const options = h264Options(encoder, audioEncoder)
          await this.run([...device, ...input, ...options, ...hlsOutput], null, false, e.dir)
          break
        } catch (error) {
          if (encoder === 'libx264' || e.exposed) throw error
          // Retry only before a player has consumed this encoder's fragments.
          for (const partial of readdirSync(e.dir)) rmSync(join(e.dir, partial), { force: true })
        }
      }
    } else {
      const options = audioEncoder === 'copy' ? ['-c', 'copy'] : ['-c:v', 'copy', '-c:a', audioEncoder]
      await this.run([...input, ...options, ...hlsOutput], null, false, e.dir)
    }
    const manifest = await readFile(join(e.dir, 'index.m3u8'), 'utf8')
    if (manifest.length > 256 * 1024) throw Error('playlist limit')
    e.manifest = manifest
  }
  async chunk(id, stream, asset, offset) {
    if (this.file.owns(id, stream)) return this.file.chunk(id, stream, asset, offset)
    if (this.remote.owns(id, stream)) return this.remote.chunk(id, stream, asset, offset)
    const e = this.entries.get(id)
    if (!e || e.stream !== stream || e.error || !e.manifest || !assetName.test(asset))
      throw new PlayerError('该播放分段已失效，请重新点播', 404)
    this.touch(e)
    const f = await open(join(e.dir, asset), 'r')
    try {
      const { size } = await f.stat()
      if (size > 32 * 1024 * 1024 || offset >= size) throw new PlayerError('分段超出支持范围')
      const data = Buffer.alloc(Math.min(chunkSize, size - offset))
      const { bytesRead } = await f.read(data, 0, data.length, offset)
      if (bytesRead !== data.length) throw new PlayerError('分段读取失败')
      return { size, bytes: data.toString('base64') }
    } finally {
      await f.close()
    }
  }
  pin(id, viewer) {
    this.file.pin(id, viewer)
    this.remote.pin(id, viewer)
    this.entries.get(id)?.viewers.add(viewer)
  }
  unpin(id, viewer) {
    this.file.unpin(id, viewer)
    this.remote.unpin(id, viewer)
    this.entries.get(id)?.viewers.delete(viewer)
  }
  close() {
    clearInterval(this.timer)
    this.remote.close()
    this.file.close()
    for (const e of this.entries.values()) {
      if (e.pending) e.job.finally(() => this.drop(e))
      else this.drop(e)
    }
  }
  owns(id, stream) { return this.remote.owns(id, stream) || this.file.owns(id, stream) }
}
