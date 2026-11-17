import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, lstat, open, readFile, writeFile, rename, rm, chmod, stat, unlink, rmdir, utimes, link, copyFile } from 'node:fs/promises'
import { constants, lstatSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { unzipSync } from 'fflate'
import xz from 'xz-decompress'
import artifacts from './ffmpeg-artifacts.json' with { type: 'json' }
import { antigravity, codex, hostProfile } from './host.mjs'
import { configuredBase, plainDirectory } from './plain-directory.mjs'

const verified = new Map(), pending = new Map()
const downloadTimeoutMs = 30 * 60_000
const lockWaitMs = downloadTimeoutMs + 2 * 60_000
const lockStaleMs = 10 * 60_000
// An environment check may first wait for another installer, then download itself.
export const ffmpegPreparationTimeoutMs = lockWaitMs + downloadTimeoutMs + 2 * 60_000
const runtimeOwner = '@kyun.si/codex-hongguo'
const failureCodes = new Set(['prepare', 'download', 'download-url', 'download-http', 'download-network', 'download-timeout',
  'archive-size', 'archive-hash', 'extract', 'binary-hash', 'probe', 'publish'])
const transientNetwork = new Set(['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'])
const transientHttp = new Set([408, 429, 500, 502, 503, 504])
const failure = (code = 'prepare', httpStatus) => Object.assign(
  Error(code === 'download-timeout'
    ? '播放组件自动准备失败：下载已超过30分钟，请检查网络后重试安装。'
    : '播放组件自动准备失败，请检查网络和缓存目录权限后重试安装。'),
  { code, ...(Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus <= 599 ? { httpStatus } : {}) },
)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

const sharedCache = { cacheName: 'hongguo-shared', dataName: 'HongguoShared' }
function locations(options) {
  const { host = codex, env = process.env, home = homedir(), platform = process.platform, arch = process.arch } = options
  const paths = platform === 'win32' ? win32 : posix
  const base = env.HONGGUO_RUNTIME_DIR || (platform === 'win32' ? env.LOCALAPPDATA : platform !== 'darwin' && env.XDG_CACHE_HOME)
  const cacheBase = base ? configuredBase(base, platform, paths) : undefined
  const cacheFor = name => cacheDirectory({ host: name, env, home, platform, paths, cacheBase })
  const owner = hostProfile(host.id)
  return { ...options, env, platform, arch, paths, host: owner, cache: cacheFor(sharedCache),
    legacyCache: cacheFor(owner), otherLegacyCache: cacheFor(owner === codex ? antigravity : codex) }
}
function settings(options = {}) {
  const config = locations(options)
  const { env, platform, arch, paths, cache } = config
  if (env.HONGGUO_FFMPEG) {
    if (!paths.isAbsolute(env.HONGGUO_FFMPEG)) throw failure()
    return { ...config, target: env.HONGGUO_FFMPEG, override: true }
  }
  const artifact = (options.artifacts || artifacts)[platform + '-' + arch]
  if (!artifact) throw Error('当前系统架构暂不支持自动准备播放组件。')
  if (artifact.cacheKey !== undefined && (!/^[a-f0-9]{16}$/.test(artifact.cacheKey) ||
    !/^[a-f0-9]{64}$/.test(artifact.binarySha256) || !Number.isSafeInteger(artifact.binaryBytes) || artifact.binaryBytes <= 0)) throw failure()
  const directory = paths.join(cache, 'runtime', 'ffmpeg', artifact.cacheKey ?? artifact.archiveSha256.slice(0, 16), platform + '-' + arch)
  return { ...config, artifact, directory, target: paths.join(directory, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg') }
}
function cacheDirectory({ host, env, home, platform, paths, cacheBase }) {
  return env.HONGGUO_RUNTIME_DIR ? paths.join(cacheBase, host.cacheName) : (platform === 'darwin'
    ? paths.join(home, 'Library', 'Caches', host.dataName)
    : platform === 'win32'
      ? paths.join(cacheBase || paths.join(home, 'AppData', 'Local'), host.dataName, 'Cache')
      : paths.join(cacheBase || paths.join(home, '.cache'), host.cacheName))
}

export function ffmpegPath(options) { return settings(options).target }
function signature(config) {
  try {
    const s = lstatSync(config.target), identity = config.artifact?.binarySha256 || config.artifact?.archiveSha256 || 'override'
    return s.isFile() && !s.isSymbolicLink() ? `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${identity}` : null
  } catch { return null }
}
export function isFfmpegReady(options) {
  try { const config = settings(options); return !!verified.get(config.target) && verified.get(config.target) === signature(config) } catch { return false }
}
async function digest(path) {
  const hash = createHash('sha256')
  for await (const bytes of createReadStream(path)) hash.update(bytes)
  return hash.digest('hex')
}
function probe(path, options) {
  return options.probe ? options.probe(path) : spawnSync(path, ['-version'], { stdio: 'ignore', timeout: 5000, windowsHide: true }).status === 0
}
function matchesArtifact(receipt, artifact) {
  // Repacked archives can retain the original receipt when the pinned binary is identical.
  const sameBinary = artifact.cacheKey && artifact.binarySha256 && receipt.owner === runtimeOwner &&
    receipt.schema === 1 && receipt.binarySha256 === artifact.binarySha256
  return (receipt.archiveSha256 === artifact.archiveSha256 || sameBinary) && /^[a-f0-9]{64}$/.test(receipt.binarySha256)
}
async function ready(config) {
  const { target, artifact } = config
  try {
    if (artifact && !await plainDirectory(config.directory, config.paths)) return false
    if (verified.get(target) && verified.get(target) === signature(config)) return true
    const s = await lstat(target)
    if (!s.isFile() || s.isSymbolicLink()) return false
    if (artifact) {
      if (!(await lstat(target + '.json')).isFile()) return false
      const receipt = JSON.parse(await readFile(target + '.json', 'utf8'))
      if (!matchesArtifact(receipt, artifact)) return false
      if (s.size !== (artifact.binaryBytes || receipt.binaryBytes) || await digest(target) !== (artifact.binarySha256 || receipt.binarySha256)) return false
    }
    if (!probe(target, config)) return false
    verified.set(target, signature(config))
    return true
  } catch { return false }
}

// A diagnostic with an explicit traffic budget only uses an installed runtime.
export function checkInstalledFfmpeg(options) { return ready(settings(options)) }

async function download(artifact, destination, fetchImpl) {
  const signal = AbortSignal.timeout(downloadTimeoutMs)
  for (let attempt = 0; ; attempt++) {
    try { return await downloadAttempt(artifact, destination, fetchImpl, signal) }
    catch (error) {
      await rm(destination, { force: true })
      const network = transientNetwork.has(error?.cause?.code || error?.code)
      const retry = network || (error?.code === 'download-http' && transientHttp.has(error.httpStatus))
      if (!retry || attempt >= 2 || signal.aborted) {
        throw failure(signal.aborted ? 'download-timeout' : network ? 'download-network'
          : failureCodes.has(error?.code) ? error.code : 'download', error?.httpStatus)
      }
      await pause((attempt + 1) * 1000)
    }
  }
}
async function downloadAttempt(artifact, destination, fetchImpl, signal) {
  const allowed = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
  let url = new URL(artifact.url), response
  for (let redirects = 0; redirects <= 6; redirects++) {
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed.has(url.hostname)) throw failure('download-url')
    response = await fetchImpl(url, { redirect: 'manual', signal })
    if (![301, 302, 303, 307, 308].includes(response.status)) break
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || redirects === 6) throw failure('download-url')
    url = new URL(location, url)
  }
  if (!response.ok || !response.body) { await response.body?.cancel(); throw failure('download-http', response.status) }
  if (Number(response.headers.get('content-length')) > artifact.archiveBytes) { await response.body.cancel(); throw failure('archive-size') }
  const file = await open(destination, 'wx', 0o600), hash = createHash('sha256')
  let size = 0
  try {
    for await (const bytes of response.body) {
      size += bytes.length
      if (size > artifact.archiveBytes) throw failure('archive-size')
      hash.update(bytes)
      await file.writeFile(bytes)
    }
    if (size !== artifact.archiveBytes) throw failure('archive-size')
    if (hash.digest('hex') !== artifact.archiveSha256) throw failure('archive-hash')
  } finally { await file.close() }
}

async function extract(artifact, archive, output) {
  const file = await open(output, 'wx', 0o600)
  try {
    if (artifact.format === 'zip') {
      const files = unzipSync(await readFile(archive), { filter: entry => entry.name === artifact.entry && entry.originalSize <= (artifact.binaryBytes || 256 * 1024 * 1024) })
      const bytes = files[artifact.entry]
      if (!bytes || (artifact.binaryBytes && bytes.length !== artifact.binaryBytes)) throw failure()
      await file.writeFile(bytes)
      return
    }
    // Read just the named regular file. Archive paths, links and modes are never applied to disk.
    const stream = new xz.XzReadableStream(ReadableFile(archive)), reader = stream.getReader()
    let buffer = Buffer.alloc(0), remaining = 0, padding = 0, selected = false, total = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        total += value.length
        if (total > 1024 * 1024 * 1024) throw failure()
        buffer = Buffer.concat([buffer, value])
        while (buffer.length) {
          if (remaining) {
            const length = Math.min(remaining, buffer.length)
            if (selected) await file.writeFile(buffer.subarray(0, length))
            buffer = buffer.subarray(length); remaining -= length
            if (!remaining && selected) return
          } else if (padding) {
            const length = Math.min(padding, buffer.length)
            buffer = buffer.subarray(length); padding -= length
          } else {
            if (buffer.length < 512) break
            const header = buffer.subarray(0, 512); buffer = buffer.subarray(512)
            const text = (start, end) => header.subarray(start, end).toString('utf8').split('\0')[0]
            const name = [text(345, 500), text(0, 100)].filter(Boolean).join('/')
            const size = parseInt(text(124, 136).trim() || '0', 8)
            if (!Number.isSafeInteger(size) || size < 0 || size > 512 * 1024 * 1024) throw failure()
            selected = name === artifact.entry
            if (selected && ((artifact.binaryBytes && size !== artifact.binaryBytes) || size > 256 * 1024 * 1024 || ![0, 48].includes(header[156]))) throw failure()
            remaining = size; padding = (512 - size % 512) % 512
          }
        }
      }
      throw failure()
    } finally { await reader.cancel().catch(() => {}) }
  } finally { await file.close() }
}
function ReadableFile(path) {
  const iterator = createReadStream(path)[Symbol.asyncIterator]()
  return new ReadableStream({
    async pull(controller) { const { value, done } = await iterator.next(); if (done) controller.close(); else controller.enqueue(value) },
    async cancel() { await iterator.return?.() },
  })
}

export async function ensureFfmpeg(options = {}) {
  const config = settings(options)
  if (await ready(config)) return config.target
  if (config.override) throw failure()
  if (pending.has(config.target)) return pending.get(config.target)
  const operation = withOwners(config, () => install(config)).finally(() => pending.delete(config.target))
  pending.set(config.target, operation)
  return operation
}

async function exists(path) {
  try { await lstat(path); return true } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}
async function createDirectory(path, paths) {
  try {
    if (await plainDirectory(path, paths)) return
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    const parent = paths.dirname(path)
    if (parent === path) throw error
    await createDirectory(parent, paths)
    try { await mkdir(path, { mode: 0o700 }) } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
    if (await plainDirectory(path, paths)) return
  }
  throw failure()
}
// Keep the registry outside the binary tree so every process locks the same inode
// even when the last user removes the component. SQLite releases the lock on exit.
async function withOwners({ cache, paths }, work) {
  if (!paths.isAbsolute(cache)) throw failure()
  await createDirectory(cache, paths)
  const file = paths.join(cache, 'ffmpeg-owners.sqlite')
  try {
    const fresh = await open(file, 'wx', 0o600)
    await fresh.close()
  } catch (error) {
    if (error.code !== 'EEXIST' || !(await lstat(file)).isFile()) throw failure()
  }
  const db = new DatabaseSync(file)
  try {
    const deadline = Date.now() + lockWaitMs
    for (;;) {
      try { db.exec('BEGIN IMMEDIATE'); break } catch (error) {
        if (error.errcode !== 5 || Date.now() >= deadline) throw error
        await pause(100)
      }
    }
    db.exec('CREATE TABLE IF NOT EXISTS installations (host TEXT PRIMARY KEY)')
    const result = await work(db)
    db.exec('COMMIT')
    return result
  } finally { db.close() }
}

// Called after plugin installation succeeds. Recheck under the same lock as
// removal: another host may have uninstalled since the initial preparation.
export async function registerFfmpegHost(options = {}) {
  const config = settings(options)
  return withOwners(config, async db => {
    if (!await ready(config)) {
      if (config.override) throw failure()
      await install(config)
    }
    db.prepare('INSERT OR IGNORE INTO installations VALUES(?)').run(config.host.id)
    if (!config.override) {
      // A previous Windows player may still hold the old executable. Its cleanup
      // can be retried on the next registration or uninstall without losing this owner.
      await removeNamespace(config.legacyCache, config.paths).catch(() => {})
    }
    return config.target
  })
}

async function removeNamespace(cache, paths) {
  const root = paths.join(cache, 'runtime', 'ffmpeg'), parent = paths.dirname(root)
  if (!paths.isAbsolute(cache)) throw failure()
  try {
    // Ancestors are outside the component namespace; never traverse a substituted link.
    if (!await plainDirectory(parent, paths)) throw failure()
    const info = await lstat(root)
    if (info.isDirectory() && !info.isSymbolicLink()) {
      // Node removes links inside this owned tree without following their targets.
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    } else await unlink(root)
    for (const target of verified.keys()) {
      const relative = paths.relative(root, target)
      if (relative && !relative.startsWith('..' + paths.sep) && !paths.isAbsolute(relative)) verified.delete(target)
    }
  } catch (error) {
    if (error.code === 'ENOENT') return 0
    throw error
  }
  await rmdir(parent).catch(() => {})
  await rmdir(cache).catch(() => {})
  return 1
}

export async function removeManagedFfmpeg(options = {}) {
  const config = locations(options)
  try {
    if (!await exists(config.cache) && (options.keepLegacy || !await exists(config.legacyCache))) return { removed: 0 }
    return await withOwners(config, async db => {
      db.prepare('DELETE FROM installations WHERE host=?').run(config.host.id)
      let removed = options.keepLegacy ? 0 : await removeNamespace(config.legacyCache, config.paths)
      if (!db.prepare('SELECT 1 FROM installations LIMIT 1').get())
        removed = Math.max(removed, await removeNamespace(config.cache, config.paths))
      return { removed }
    })
  } catch {
    throw Error('插件已卸载，但播放组件清理失败。请关闭播放器并检查缓存目录权限后，重新运行 uninstall。')
  }
}

// An older client may still launch this pathname, so keep its directory intact.
// A hard link lets both versions use the same bytes until that client upgrades.
async function stageLegacy(config, output) {
  const { paths, artifact } = config
  if (!artifact.binarySha256) return null
  const suffix = paths.relative(config.cache, config.target)
  for (const cache of [config.legacyCache, config.otherLegacyCache]) {
    const source = paths.join(cache, suffix)
    try {
      if (!await plainDirectory(paths.dirname(source), paths) ||
        !(await lstat(source)).isFile() || !(await lstat(source + '.json')).isFile()) continue
      const contents = await readFile(source + '.json', 'utf8')
      if (!matchesArtifact(JSON.parse(contents), artifact)) continue
      try { await link(source, output) } catch (error) {
        if (!['EXDEV', 'EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP', 'EMLINK'].includes(error.code)) throw error
        await copyFile(source, output, constants.COPYFILE_EXCL)
      }
      // Verify the staged inode before executing it, even if the old receipt matches.
      const file = await lstat(output)
      if (file.isFile() && (!artifact.binaryBytes || file.size === artifact.binaryBytes) &&
        await digest(output) === artifact.binarySha256 && probe(output, config)) return contents
    } catch { /* Missing or unusable legacy entries are not a reason to reject a fresh install. */ }
    await rm(output, { force: true })
  }
  return null
}
async function install(config) {
  const { directory, target, artifact } = config
  const lock = directory + '.lock', deadline = Date.now() + lockWaitMs
  await createDirectory(directory, config.paths)
  let owned = false
  while (!owned) {
    try { await mkdir(lock, { mode: 0o700 }); owned = true }
    catch (error) {
      if (error.code !== 'EEXIST' || Date.now() > deadline) throw failure()
      if (await ready(config)) return target
      try { if (Date.now() - (await stat(lock)).mtimeMs > lockStaleMs) await rm(lock, { recursive: true, force: true }) } catch { /* Another process released the lock. */ }
      await pause(200)
    }
  }
  // Older plugin versions consider a ten-minute-old lock abandoned. Keep the
  // active download's lock fresh so they cannot steal it during a slow transfer.
  let refreshing = Promise.resolve()
  const heartbeat = setInterval(() => {
    const now = new Date()
    refreshing = refreshing.then(() => utimes(lock, now, now)).catch(() => {})
  }, 30_000)
  heartbeat.unref?.()
  const paths = config.platform === 'win32' ? win32 : posix
  const temporary = paths.basename(target) + '.' + randomUUID(), archive = paths.join(directory, temporary + '.archive'), output = paths.join(directory, temporary + '.part')
  let stage = 'download'
  try {
    if (await ready(config)) return target
    let receipt = await stageLegacy(config, output)
    if (!receipt) {
      await download(artifact, archive, config.fetchImpl || fetch)
      stage = 'extract'
      await extract(artifact, archive, output)
      const binarySha256 = await digest(output)
      if (artifact.binarySha256 && binarySha256 !== artifact.binarySha256) throw failure('binary-hash')
      await chmod(output, 0o755)
      if (!probe(output, config)) throw failure('probe')
      receipt = JSON.stringify({ owner: runtimeOwner, schema: 1, archiveSha256: artifact.archiveSha256,
        binarySha256, binaryBytes: (await stat(output)).size, version: artifact.version }) + '\n'
    }
    stage = 'publish'
    if (config.platform === 'win32') await rm(target, { force: true })
    await rename(output, target)
    await writeFile(target + '.json', receipt, { mode: 0o600 })
    verified.set(target, signature(config))
    return target
  } catch (error) { throw failure(failureCodes.has(error?.code) && error.code !== 'prepare' ? error.code : stage, error?.httpStatus) }
  finally {
    clearInterval(heartbeat)
    await refreshing
    await Promise.all([rm(archive, { force: true }), rm(output, { force: true }), rm(lock, { recursive: true, force: true })])
  }
}
