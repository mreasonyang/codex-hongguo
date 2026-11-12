import { spawn, spawnSync } from 'node:child_process'
import { findExecutable } from '../runtime/executables.mjs'
import { ensureFfmpeg, isFfmpegReady } from '../runtime/ffmpeg-runtime.mjs'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { PlayerError } from './errors.mjs'
import { prepareAdaptive } from './adaptive.mjs'
import { prepareTracks } from './tracks.mjs'
import { cdn } from './sources/network.mjs'
import { errorCodes } from '../../provider-kit/sdk/index.mjs'
import { parseId } from './sources/ids.mjs'

const MB = 1024 * 1024
const maxEpisode = 256 * MB
export { cdn } from './sources/network.mjs'
export const ffmpeg = findExecutable('ffmpeg', process.env.HONGGUO_FFMPEG)
export function hasFfmpeg() {
  return isFfmpegReady()
}
export async function runFfmpeg(args, input = null, capture = false, cwd = undefined, { signal } = {}) {
  await ensureFfmpeg()
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
      cwd,
      stdio: ['pipe', capture ? 'pipe' : 'ignore', 'ignore'],
      windowsHide: true,
      timeout: 120_000,
      killSignal: 'SIGKILL',
      signal,
    })
    const chunks = []
    let bytes = 0
    child.stdout?.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes <= MB) chunks.push(chunk)
      else child.kill()
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
    child.on('error', error => { if (error.name !== 'AbortError') reject(new PlayerError('FFmpeg 启动失败，请检查本机安装')) })
    child.on('close', (code) =>
      code === 0 && bytes <= MB
        ? resolve(Buffer.concat(chunks))
        : reject(new PlayerError('FFmpeg 无法处理该素材或当前编码')),
    )
  })
}

export async function remux(raw, output, codec, key, run = runFfmpeg) {
  const file = basename(raw)
  if (!/^[a-zA-Z0-9.-]+$/.test(file) || (key && !/^[0-9a-f]{32}$/i.test(key)))
    throw new PlayerError('分集授权或素材名称无效')
  // The concat control stream supplies private MOV options through stdin.
  // It references only our generated basename inside the private working directory.
  const control = key
    ? "ffconcat version 1.0\nfile 'file:" + file + "'\noption decryption_key " + key + '\n'
    : null
  const input = key
    ? ['-format_whitelist', 'concat,mov', '-safe', '0', '-f', 'concat', '-i', 'pipe:0']
    : ['-f', 'mov', '-i', raw]
  await run(
    [
      '-protocol_whitelist',
      'file,pipe',
      ...input,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0?',
      '-c',
      'copy',
      ...(/hevc|h265|bytevc1/i.test(codec) ? ['-tag:v', 'hvc1'] : []),
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      output,
    ],
    control,
    false,
    dirname(raw),
  )
}

export async function prepareCandidate(stream, raw, output, fetchMedia, budget = maxEpisode, run = runFfmpeg,
  { firstHlsSegment = false } = {}) {
  const codec = String(stream.codec || 'MP4').replace(/[^\w.-]/g, '').slice(0, 24)
  if (stream.kind === 'hls' || stream.kind === 'dash') {
    if (stream.encryption) throw new PlayerError('该分段片源需要单文件播放授权')
    mkdirSync(raw, { mode: 0o700 })
    await prepareAdaptive(stream.url, raw, output, { cdn: fetchMedia, run, codec, budget, firstHlsSegment })
  } else if (stream.kind === 'tracks') {
    mkdirSync(raw, { mode: 0o700 })
    await prepareTracks(stream, raw, output, { cdn: fetchMedia, run, budget })
  } else if (stream.kind === 'file') {
    const key = stream.encryption?.key
    if (stream.encryption && (stream.encryption.kind !== 'cenc' || !/^[a-f0-9]{32}$/i.test(key || '')))
      throw new PlayerError('片源未提供可用的播放授权')
    const { body, limit } = await fetchMedia(stream.url, budget, 60000)
    await pipeline(body, limit, createWriteStream(raw, { mode: 0o600, flags: 'wx' }))
    await remux(raw, output, codec, key, run)
  } else throw new PlayerError('不支持的媒体类型')
  return codec
}

// SQLite coordinates multiple stdio processes sharing the same user cache.
export class MediaCache {
  constructor(store, resolve, { maxFiles = 40, maxBytes = 1024 * MB, revision = () => '' } = {}) {
    this.db = store.db
    this.resolve = resolve
    this.revision = revision
    this.dir = join(store.root, 'media')
    this.maxFiles = maxFiles
    this.maxBytes = maxBytes
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    this.db.exec(`CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY, status TEXT, owner TEXT, expires INTEGER, accessed INTEGER, size INTEGER DEFAULT 0,
      codec TEXT DEFAULT '', reason TEXT DEFAULT '', error_code TEXT, hold_until INTEGER DEFAULT 0, revision TEXT DEFAULT '')`)
    this.transaction(() => {
      const columns = this.db.prepare('PRAGMA table_info(media)').all().map(column => column.name)
      if (!columns.includes('error_code')) this.db.exec('ALTER TABLE media ADD COLUMN error_code TEXT')
      if (!columns.includes('revision'))
        this.db.exec("ALTER TABLE media ADD COLUMN revision TEXT DEFAULT ''")
    })
    for (const file of readdirSync(this.dir)) {
      if (
        /^[a-f0-9-]+\.part\.(source|mp4)$/.test(file) &&
        Date.now() - statSync(join(this.dir, file), { throwIfNoEntry: false })?.mtimeMs > 3600000
      )
        rmSync(join(this.dir, file), { recursive: true, force: true })
    }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
  path(id) {
    parseId(id, 'episode')
    return join(this.dir, id + '.mp4')
  }
  hold(id) {
    this.db
      .prepare("UPDATE media SET hold_until=?,accessed=? WHERE id=? AND status='ready'")
      .run(Date.now() + 120000, Date.now(), id)
  }
  prepare(id, retry = false) {
    const file = this.path(id),
      now = Date.now(),
      owner = randomUUID(), revision = this.revision(id)
    const result = this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM media WHERE id=?').get(id)
      const current = row?.revision === revision
      if (row && !current) rmSync(file, { force: true })
      if (current && row.status === 'ready' && existsSync(file)) {
        this.hold(id)
        return { status: 'ready', codec: row.codec }
      }
      if (current && row.status === 'error' && !retry && row.expires > now)
        return { status: 'error', reason: row.reason, ...(row.error_code ? { code: row.error_code } : {}) }
      if (current && row.status === 'working' && row.expires > now) return { status: 'preparing' }
      if (
        this.db.prepare("SELECT count(*) AS n FROM media WHERE status='working' AND expires>?").get(now).n >=
        2
      )
        return { status: 'preparing' }
      this.db
        .prepare(
          `INSERT INTO media(id,status,owner,expires,accessed,revision) VALUES(?,'working',?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET status='working', owner=excluded.owner,expires=excluded.expires,accessed=excluded.accessed,revision=excluded.revision`,
        )
        .run(id, owner, now + 600000, now, revision)
      return null
    })
    if (result) return result
    this.build(id, owner, revision).catch(() => {}) // State is published to all pollers by build.
    return { status: 'preparing' }
  }
  async build(id, owner, revision) {
    const raw = join(this.dir, owner + '.part.source'),
      output = join(this.dir, owner + '.part.mp4')
    try {
      let codec, lastError
      for (let authorizationAttempt = 0; authorizationAttempt < 2; authorizationAttempt++) {
        const descriptor = await this.resolve(id)
        const fetchMedia = descriptor.fetchMedia || cdn
        lastError = new PlayerError('该集暂未提供可播放的片源')
        for (const stream of descriptor.candidates || []) {
          try {
            codec = await prepareCandidate(stream, raw, output, fetchMedia)
            lastError = null
            break
          } catch (error) { lastError = error; rmSync(output, { force: true }) }
          finally { rmSync(raw, { recursive: true, force: true }) }
        }
        if (!lastError || lastError.code !== 'MEDIA_EXPIRED' || authorizationAttempt) break
      }
      if (lastError) throw lastError
      if (this.revision(id) !== revision) {
        this.db.prepare('DELETE FROM media WHERE id=? AND owner=?').run(id, owner)
        return
      }
      const size = statSync(output).size
      this.transaction(() => {
        if (this.db.prepare('SELECT owner FROM media WHERE id=?').get(id)?.owner !== owner) return
        const ready = this.db
          .prepare("SELECT id,size,hold_until FROM media WHERE status='ready' ORDER BY accessed")
          .all()
        let bytes = size + ready.reduce((n, r) => n + r.size, 0),
          count = ready.length + 1
        const victims = []
        for (const r of ready) {
          if (bytes <= this.maxBytes && count <= this.maxFiles) break
          if (r.hold_until > Date.now()) continue
          victims.push(r.id)
          bytes -= r.size
          count--
        }
        if (bytes > this.maxBytes || count > this.maxFiles) throw new PlayerError('缓存已满，稍后重试')
        for (const victim of victims) {
          rmSync(this.path(victim), { force: true })
          this.db.prepare('DELETE FROM media WHERE id=?').run(victim)
        }
        renameSync(output, this.path(id))
        this.db
          .prepare("UPDATE media SET status='ready',size=?,codec=?,hold_until=? WHERE id=?")
          .run(size, codec, Date.now() + 120000, id)
      })
    } catch (e) {
      this.db
        .prepare("UPDATE media SET status='error',reason=?,error_code=?,expires=? WHERE id=? AND owner=?")
        .run(e instanceof PlayerError ? e.message : '媒体准备失败，请重试', errorCodes.includes(e?.code) ? e.code : null, Date.now() + 30000, id, owner)
    } finally {
      rmSync(raw, { recursive: true, force: true })
      rmSync(output, { force: true })
    }
  }
}
