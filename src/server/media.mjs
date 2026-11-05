import { spawn, spawnSync } from 'node:child_process'
import { findExecutable } from '../runtime/executables.mjs'
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PlayerError } from './errors.mjs'
import { prepareAdaptive } from './adaptive.mjs'

const MB = 1024 * 1024
const maxEpisode = 256 * MB
const domains =
  /(?:^|\.)(?:qznovelvod\.com|byteimg\.com|fqnovelpic\.com|douyinvod\.com|bytecdn\.cn|ibytedtos\.com|snssdk\.com|pstatp\.com)$/i

export async function cdn(url, budget, timeout, redirects = 0, range) {
  const target = new URL(url)
  // Some first-party CDN locators still use HTTP. Upgrade before the first request.
  if (target.protocol === 'http:') target.protocol = 'https:'
  if (
    target.protocol !== 'https:' ||
    target.port ||
    target.username ||
    target.password ||
    !domains.test(target.hostname)
  )
    throw new PlayerError('片源地址不在支持的媒体域名内')
  const headers = {}
  if (range) {
    if (
      !Number.isSafeInteger(range.offset) ||
      range.offset < 0 ||
      !Number.isSafeInteger(range.length) ||
      range.length < 1 ||
      range.length > budget ||
      !Number.isSafeInteger(range.offset + range.length)
    )
      throw new PlayerError('片源字节范围无效')
    headers.Range = 'bytes=' + range.offset + '-' + (range.offset + range.length - 1)
  }
  const res = await fetch(target, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeout) })
  if ([301, 302, 303, 307, 308].includes(res.status) && redirects < 3 && res.headers.get('location')) {
    await res.body?.cancel()
    return cdn(new URL(res.headers.get('location'), target), budget, timeout, redirects + 1, range)
  }
  const validRange =
    !range ||
    (res.status === 206 &&
      res.headers.get('content-range')?.split('/')[0] ===
        'bytes ' + range.offset + '-' + (range.offset + range.length - 1))
  if (!validRange || !res.ok || !res.body || Number(res.headers.get('content-length')) > budget) {
    await res.body?.cancel()
    throw new PlayerError('媒体地址已失效或超过大小限制，请重试')
  }
  let bytes = 0
  const limit = new Transform({
    transform(chunk, encoding, done) {
      bytes += chunk.length
      done(bytes > budget ? new PlayerError('素材超过大小限制') : null, chunk)
    },
  })
  return { body: res.body, limit, url: target.href }
}
export const ffmpeg = findExecutable('ffmpeg', process.env.HONGGUO_FFMPEG)
export function hasFfmpeg() {
  return spawnSync(ffmpeg, ['-version'], { stdio: 'ignore', timeout: 2500, windowsHide: true }).status === 0
}
export function runFfmpeg(args, input = null, capture = false, cwd = undefined) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...args], {
      cwd,
      stdio: ['pipe', capture ? 'pipe' : 'ignore', 'ignore'],
      windowsHide: true,
      timeout: 120_000,
      killSignal: 'SIGKILL',
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
    child.on('error', () => reject(new PlayerError('FFmpeg 启动失败，请检查本机安装')))
    child.on('close', (code) =>
      code === 0 && bytes <= MB
        ? resolve(Buffer.concat(chunks))
        : reject(new PlayerError('FFmpeg 无法处理该素材或当前编码')),
    )
  })
}

export async function remux(raw, output, codec, key) {
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
  await runFfmpeg(
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

// SQLite coordinates multiple stdio processes sharing the same user cache.
export class MediaCache {
  constructor(store, resolve, { maxFiles = 40, maxBytes = 1024 * MB } = {}) {
    this.db = store.db
    this.resolve = resolve
    this.dir = join(store.root, 'media')
    this.maxFiles = maxFiles
    this.maxBytes = maxBytes
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    this.db.exec(`CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY, status TEXT, owner TEXT, expires INTEGER, accessed INTEGER, size INTEGER DEFAULT 0,
      codec TEXT DEFAULT '', reason TEXT DEFAULT '', hold_until INTEGER DEFAULT 0)`)
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
    if (!/^hg-[0-9]{1,32}$/.test(id)) throw new PlayerError('无效分集')
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
      owner = randomUUID()
    const result = this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM media WHERE id=?').get(id)
      if (row?.status === 'ready' && existsSync(file)) {
        this.hold(id)
        return { status: 'ready', codec: row.codec }
      }
      if (row?.status === 'error' && !retry && row.expires > now)
        return { status: 'error', reason: row.reason }
      if (row?.status === 'working' && row.expires > now) return { status: 'preparing' }
      if (
        this.db.prepare("SELECT count(*) AS n FROM media WHERE status='working' AND expires>?").get(now).n >=
        2
      )
        return { status: 'preparing' }
      this.db
        .prepare(
          `INSERT INTO media(id,status,owner,expires,accessed) VALUES(?,'working',?,?,?)
        ON CONFLICT(id) DO UPDATE SET status='working', owner=excluded.owner,expires=excluded.expires,accessed=excluded.accessed`,
        )
        .run(id, owner, now + 600000, now)
      return null
    })
    if (result) return result
    this.build(id, owner).catch(() => {}) // State is published to all pollers by build.
    return { status: 'preparing' }
  }
  async build(id, owner) {
    const raw = join(this.dir, owner + '.part.source'),
      output = join(this.dir, owner + '.part.mp4')
    try {
      const { playback, contentKey } = await this.resolve(id.slice(3))
      const streams = (playback.streams || []).filter((s) => s.url)
      const file = streams.find((s) => !s.hls && !s.dash)
      const key = contentKey?.key
      const candidates = [
        file && (file.protected || playback.protected) ? file : undefined,
        streams.find((s) => s.hls),
        streams.find((s) => s.dash),
        file,
      ].filter(Boolean)
      let codec,
        lastError = new PlayerError('该集暂未提供可播放的片源')
      for (const stream of new Set(candidates)) {
        codec = String(stream.codec || 'MP4')
          .replace(/[^\w.-]/g, '')
          .slice(0, 24)
        try {
          if (stream.hls || stream.dash) {
            if (stream.protected || playback.protected) throw new PlayerError('该分段片源需要单文件播放授权')
            mkdirSync(raw, { mode: 0o700 })
            await prepareAdaptive(stream.url, raw, output, { cdn, run: runFfmpeg, codec, budget: maxEpisode })
          } else {
            if ((playback.protected || stream.protected) && !/^[a-f0-9]{32}$/i.test(key || ''))
              throw new PlayerError('片源未提供可用的播放授权')
            const { body, limit } = await cdn(stream.url, maxEpisode, 60000)
            await pipeline(body, limit, createWriteStream(raw, { mode: 0o600, flags: 'wx' }))
            await remux(raw, output, codec, key)
          }
          lastError = null
          break
        } catch (error) {
          lastError = error
          rmSync(output, { force: true })
        } finally {
          rmSync(raw, { recursive: true, force: true })
        }
      }
      if (lastError) throw lastError
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
        .prepare("UPDATE media SET status='error',reason=?,expires=? WHERE id=? AND owner=?")
        .run(e instanceof PlayerError ? e.message : '媒体准备失败，请重试', Date.now() + 30000, id, owner)
    } finally {
      rmSync(raw, { recursive: true, force: true })
      rmSync(output, { force: true })
    }
  }
}
