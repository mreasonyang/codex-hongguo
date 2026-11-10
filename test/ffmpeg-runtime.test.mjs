import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, readdir, realpath, mkdir, symlink, lstat, rename, copyFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { zipSync } from 'fflate'
import { ensureFfmpeg, ffmpegPath, isFfmpegReady, removeManagedFfmpeg } from '../src/runtime/ffmpeg-runtime.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "红果 media '$ ")))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const binary = Buffer.from('fixture-native-executable'), archive = zipSync({ ffmpeg: binary, '../../escape': Buffer.from('not extracted') })
  const artifact = { version: 'test', url: 'https://www.osxexperts.net/fixture.zip', format: 'zip', entry: 'ffmpeg', archiveBytes: archive.length, archiveSha256: sha(archive), binaryBytes: binary.length, binarySha256: sha(binary) }
  const options = { env: { HONGGUO_RUNTIME_DIR: directory }, platform: process.platform, arch: process.arch, artifacts: { [process.platform + '-' + process.arch]: artifact }, probe: () => true }
  return { directory, binary, archive, artifact, options }
}

test('a cold installation downloads once, verifies bytes, and remains usable without network or a system FFmpeg', async t => {
  const f = await fixture(t)
  let downloads = 0
  const options = { ...f.options, fetchImpl: async () => { downloads++; return new Response(f.archive) } }
  const [first, second] = await Promise.all([ensureFfmpeg(options), ensureFfmpeg(options)])
  assert.equal(first, second)
  assert.equal(downloads, 1)
  assert.deepEqual(await readFile(first), f.binary)
  assert.equal(isFfmpegReady(options), true)
  await ensureFfmpeg({ ...options, fetchImpl: () => assert.fail('a warm cache must not use the network') })
  assert.deepEqual(await readdir(f.directory), ['codex-hongguo'])
  await assert.rejects(readFile(join(f.directory, 'escape')), { code: 'ENOENT' })
})

function compactOptions(f, binary = f.binary) {
  const archive = zipSync({ ffmpeg: binary, 'COPYING.GPLv3': Buffer.from('test license') })
  const artifact = { ...f.artifact, cacheKey: f.artifact.archiveSha256.slice(0, 16),
    archiveBytes: archive.length, archiveSha256: sha(archive), binaryBytes: binary.length, binarySha256: sha(binary) }
  return { archive, options: { ...f.options, artifacts: { [process.platform + '-' + process.arch]: artifact } } }
}

test('a compact archive reuses the verified legacy executable across a process restart without downloading', async t => {
  const f = await fixture(t)
  const original = await ensureFfmpeg({ ...f.options, fetchImpl: async () => new Response(f.archive) })
  const receipt = await readFile(original + '.json', 'utf8')
  const { options } = compactOptions(f)
  assert.equal(ffmpegPath(options), original)
  // A fresh module has no in-memory verification record from the legacy install.
  const fresh = await import('../src/runtime/ffmpeg-runtime.mjs?compact-reuse')
  assert.equal(await fresh.ensureFfmpeg({ ...options, fetchImpl: () => assert.fail('an unchanged binary must reuse the old cache') }), original)
  assert.deepEqual(await readFile(original), f.binary)
  assert.equal(await readFile(original + '.json', 'utf8'), receipt, 'retain the actual original archive provenance')
})

test('a shared cache key cannot reuse an executable with a different pinned binary hash', async t => {
  const f = await fixture(t)
  const original = await ensureFfmpeg({ ...f.options, fetchImpl: async () => new Response(f.archive) })
  const replacement = Buffer.from('new trusted executable'), { archive, options } = compactOptions(f, replacement)
  assert.equal(isFfmpegReady(options), false)
  let downloads = 0
  assert.equal(await ensureFfmpeg({ ...options, fetchImpl: async () => { downloads++; return new Response(archive) } }), original)
  assert.equal(downloads, 1)
  assert.deepEqual(await readFile(original), replacement)
})

test('a refreshed upstream binary gets its own verified cache and leaves the earlier installation intact', async t => {
  const f = await fixture(t)
  const original = await ensureFfmpeg({ ...f.options, fetchImpl: async () => new Response(f.archive) })
  const receipt = await readFile(original + '.json', 'utf8')
  const binary = Buffer.from('refreshed-native-executable'), archive = zipSync({ ffmpeg: binary })
  const artifact = { ...f.artifact, archiveBytes: archive.length, archiveSha256: sha(archive),
    binaryBytes: binary.length, binarySha256: sha(binary) }
  const options = { ...f.options, artifacts: { [process.platform + '-' + process.arch]: artifact },
    fetchImpl: async () => new Response(archive) }
  const refreshed = await ensureFfmpeg(options)
  assert.notEqual(refreshed, original)
  assert.deepEqual(await readFile(refreshed), binary)
  assert.deepEqual(await readFile(original), f.binary)
  assert.equal(await readFile(original + '.json', 'utf8'), receipt)
})

test('a compact installer rejects a corrupt legacy binary and repairs it from the compact archive', async t => {
  const f = await fixture(t)
  const original = await ensureFfmpeg({ ...f.options, fetchImpl: async () => new Response(f.archive) })
  await writeFile(original, 'corrupt')
  const { archive, options } = compactOptions(f)
  let downloads = 0
  await ensureFfmpeg({ ...options, fetchImpl: async () => { downloads++; return new Response(archive) } })
  assert.equal(downloads, 1)
  assert.deepEqual(await readFile(original), f.binary)
})

test('a legacy receipt with the wrong owner cannot enable cross-archive reuse', async t => {
  const f = await fixture(t)
  const original = await ensureFfmpeg({ ...f.options, fetchImpl: async () => new Response(f.archive) })
  const receipt = JSON.parse(await readFile(original + '.json', 'utf8'))
  await writeFile(original + '.json', JSON.stringify({ ...receipt, owner: 'another-application' }))
  const fresh = await import('../src/runtime/ffmpeg-runtime.mjs?compact-owner')
  const { options } = compactOptions(f)
  let downloads = 0
  await assert.rejects(fresh.ensureFfmpeg({ ...options, fetchImpl: async () => { downloads++; throw Error('synthetic network failure') } }), /自动准备失败/)
  assert.equal(downloads, 1)
  assert.deepEqual(await readFile(original), f.binary)
})

test('compact cache identifiers must be bounded hashes with a pinned executable identity', async t => {
  const f = await fixture(t)
  for (const patch of [{ cacheKey: '../escape' }, { cacheKey: 'a'.repeat(16), binarySha256: undefined },
    { cacheKey: 'a'.repeat(16), binaryBytes: 0 }]) {
    await assert.rejects(ensureFfmpeg({ ...f.options,
      artifacts: { [process.platform + '-' + process.arch]: { ...f.artifact, ...patch } },
      fetchImpl: () => assert.fail('invalid cache identity must fail before network access'),
    }), /自动准备失败/)
  }
})

test('the real Windows/Linux component reuses a legacy cache and receipt without network access', {
  skip: !['win32', 'linux'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch),
}, async t => {
  const key = process.platform + '-' + process.arch
  const artifacts = JSON.parse(await readFile(new URL('../src/runtime/ffmpeg-artifacts.json', import.meta.url), 'utf8'))
  const upstream = JSON.parse(await readFile(new URL('../third_party/ffmpeg/upstream-artifacts.json', import.meta.url), 'utf8')).platforms[key]
  const artifact = artifacts[key]
  assert.equal(artifact.cacheKey, upstream.archiveSha256.slice(0, 16))
  const source = await ensureFfmpeg()
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'hongguo-real-legacy-cache-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const options = { env: { HONGGUO_RUNTIME_DIR: directory } }
  const oldPath = ffmpegPath({ ...options, artifacts: { [key]: upstream } })
  assert.equal(ffmpegPath(options), oldPath)
  await mkdir(dirname(oldPath), { recursive: true })
  await copyFile(source, oldPath)
  await chmod(oldPath, 0o755)
  const receipt = JSON.stringify({ owner: '@kyun.si/codex-hongguo', schema: 1, version: upstream.version,
    archiveSha256: upstream.archiveSha256, binarySha256: artifact.binarySha256, binaryBytes: artifact.binaryBytes })
  await writeFile(oldPath + '.json', receipt)
  assert.equal(await ensureFfmpeg({ ...options, fetchImpl: () => assert.fail('real legacy bytes must not be downloaded again') }), oldPath)
  assert.equal(await readFile(oldPath + '.json', 'utf8'), receipt)
})

test('a corrupt cache is repaired from a verified archive and partial or wrong downloads are never executed', async t => {
  const f = await fixture(t)
  let probes = 0
  const options = { ...f.options, probe: () => { probes++; return true }, fetchImpl: async () => new Response(f.archive) }
  const path = await ensureFfmpeg(options)
  await writeFile(path, 'broken')
  assert.equal(isFfmpegReady(options), false)
  await ensureFfmpeg(options)
  assert.deepEqual(await readFile(path), f.binary)
  await rm(path)
  const before = probes
  await assert.rejects(ensureFfmpeg({ ...options, fetchImpl: async () => new Response(f.archive.subarray(1)) }), /自动准备失败/)
  assert.equal(probes, before)
  assert.equal(isFfmpegReady(options), false)
  await assert.rejects(readFile(path), { code: 'ENOENT' })
  await ensureFfmpeg(options)
  assert.equal(isFfmpegReady(options), true)
})

test('download failures stay fixed and retryable, HTTPS redirects are constrained, and unsupported CPUs fail before fetching', async t => {
  const f = await fixture(t)
  const options = { ...f.options, fetchImpl: async () => { throw Error('SYNTHETIC_PRIVATE_DOWNLOAD_DETAIL') } }
  await assert.rejects(ensureFfmpeg(options), error => /自动准备失败/.test(error.message) && !error.message.includes('SYNTHETIC'))
  await assert.rejects(ensureFfmpeg({ ...options, fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) }), /自动准备失败/)
  await assert.rejects(ensureFfmpeg({ ...options, arch: 'unsupported' }), /系统架构/)
  await ensureFfmpeg({ ...options, fetchImpl: async () => new Response(f.archive) })
})

test('a failed explicit native-binary override does not silently run a different program', async t => {
  const f = await fixture(t)
  const options = { ...f.options, env: { HONGGUO_FFMPEG: join(f.directory, 'absent') }, fetchImpl: () => assert.fail('an explicit override must not download') }
  assert.equal(ffmpegPath(options), options.env.HONGGUO_FFMPEG)
  await assert.rejects(ensureFfmpeg(options), /自动准备失败/)
})

test('transient HTTP and interrupted downloads retry from a clean archive before publishing verified bytes', async t => {
  const f = await fixture(t)
  let downloads = 0
  const options = { ...f.options, fetchImpl: async () => {
    downloads++
    if (downloads === 1) return new Response('temporary outage', { status: 503 })
    if (downloads === 2) {
      let sent = false
      return new Response(new ReadableStream({ pull(controller) {
        if (!sent) { sent = true; controller.enqueue(f.archive.subarray(0, 20)) }
        else controller.error(Object.assign(Error('SYNTHETIC_PRIVATE_NETWORK_DETAIL'), { code: 'ECONNRESET' }))
      } }))
    }
    return new Response(f.archive)
  } }
  const target = await ensureFfmpeg(options)
  assert.equal(downloads, 3)
  assert.deepEqual(await readFile(target), f.binary)
  assert.equal(isFfmpegReady(options), true)
})

test('connection timeouts stop after three attempts without retaining raw network errors', async t => {
  const f = await fixture(t)
  let downloads = 0
  await assert.rejects(ensureFfmpeg({ ...f.options, fetchImpl: async () => {
    downloads++
    throw new TypeError('SYNTHETIC_PRIVATE_NETWORK_DETAIL', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } })
  } }), error => {
    assert.equal(error.code, 'download-network')
    assert.equal(error.cause, undefined)
    assert.doesNotMatch(error.message, /SYNTHETIC/)
    return true
  })
  assert.equal(downloads, 3)
  await assert.rejects(lstat(ffmpegPath(f.options)), { code: 'ENOENT' })
})

function downloadClock(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  t.mock.method(AbortSignal, 'timeout', milliseconds => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(new DOMException('SYNTHETIC_PRIVATE_TIMEOUT_DETAIL', 'TimeoutError')), milliseconds)
    return controller.signal
  })
}

test('a slow download can finish beyond the former five-minute deadline', async t => {
  const f = await fixture(t)
  downloadClock(t)
  let connected, release, signal
  const started = new Promise(resolve => { connected = resolve })
  const operation = ensureFfmpeg({ ...f.options, fetchImpl: async (_url, options) => {
    signal = options.signal
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
      release = () => { controller.enqueue(f.archive); controller.close() }
      connected()
    } }))
  } })
  await started
  try {
    t.mock.timers.tick(6 * 60_000)
    assert.equal(signal.aborted, false)
  } finally {
    if (!signal.aborted) release()
    await operation.catch(() => {})
  }
  assert.deepEqual(await readFile(await operation), f.binary)
})

test('the thirty-minute download deadline remains bounded and reports a safe timeout reason', async t => {
  const f = await fixture(t)
  downloadClock(t)
  let connected, signal, downloads = 0
  const started = new Promise(resolve => { connected = resolve })
  const operation = ensureFfmpeg({ ...f.options, fetchImpl: async (_url, options) => {
    downloads++; signal = options.signal
    return new Response(new ReadableStream({ start(controller) {
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
      connected()
    } }))
  } })
  const rejected = assert.rejects(operation, error => {
    assert.equal(error.code, 'download-timeout')
    assert.match(error.message, /30分钟/)
    assert.doesNotMatch(error.message, /SYNTHETIC|fixture\.zip/)
    assert.equal(error.cause, undefined)
    return true
  })
  await started
  t.mock.timers.tick(30 * 60_000 - 1)
  assert.equal(signal.aborted, false)
  t.mock.timers.tick(1)
  await rejected
  assert.equal(downloads, 1)
  await assert.rejects(lstat(ffmpegPath(f.options)), { code: 'ENOENT' })
  assert.deepEqual(await readdir(dirname(ffmpegPath(f.options))), [])
})

test('a long-running installer refreshes its lock so older versions cannot treat it as abandoned', async t => {
  const f = await fixture(t)
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: Date.now() })
  let connected, release
  const started = new Promise(resolve => { connected = resolve })
  const operation = ensureFfmpeg({ ...f.options, fetchImpl: async () => {
    connected()
    return new Promise(resolve => { release = () => resolve(new Response(f.archive)) })
  } })
  await started
  const lock = dirname(ffmpegPath(f.options)) + '.lock'
  try {
    t.mock.timers.tick(11 * 60_000)
    for (let attempt = 0; attempt < 50 && Date.now() - (await lstat(lock)).mtimeMs >= 60_000; attempt++)
      await new Promise(resolve => setImmediate(resolve))
    assert.ok(Date.now() - (await lstat(lock)).mtimeMs < 60_000)
  } finally {
    release()
    await operation.catch(() => {})
  }
  assert.deepEqual(await readFile(await operation), f.binary)
  await assert.rejects(lstat(lock), { code: 'ENOENT' })
})

test('permanent HTTP errors and integrity failures do not retry and only expose fixed diagnostic metadata', async t => {
  for (const reason of ['http', 'hash', 'probe']) await t.test(reason, async t => {
    const f = await fixture(t)
    let downloads = 0
    const wrong = Buffer.from(f.archive); wrong[0] ^= 1
    const options = { ...f.options, probe: () => reason !== 'probe', fetchImpl: async () => {
      downloads++
      return reason === 'http' ? new Response('SYNTHETIC_PRIVATE_HTTP_DETAIL', { status: 403 })
        : new Response(reason === 'hash' ? wrong : f.archive)
    } }
    await assert.rejects(ensureFfmpeg(options), error => {
      assert.equal(error.code, reason === 'http' ? 'download-http' : reason === 'hash' ? 'archive-hash' : 'probe')
      assert.equal(error.httpStatus, reason === 'http' ? 403 : undefined)
      assert.doesNotMatch(error.message, /SYNTHETIC|fixture\.zip/)
      return true
    })
    assert.equal(downloads, 1)
    assert.equal(isFfmpegReady(options), false)
    await assert.rejects(lstat(ffmpegPath(options)), { code: 'ENOENT' })
  })
})

test('XZ archives are decoded without a system tar or xz program', async t => {
  const f = await fixture(t)
  const archive = Buffer.from('/Td6WFoAAATm1rRGAgAhARYAAAB0L+Wj4Cf/AH1dADkdSgEE6tmdRLuPMqEN1GnOxZ3PNdIA9kbUKZ1ZFYg80E5+tTVPpaQNJeqQV9yrg0dD7GAGPqBSYhAxG2bv4TuBScRHqIOoz0DIwskb14eZE09B+8HxzrQ0XMdb9RY5aJpCFcR7wTghGCkaSzMD5iq/8Y0IrbIZUu4Y0y8AAAAAAGpjA9Qk+eYsAAGZAYBQAABtIrlFscRn+wIAAAAABFla', 'base64')
  const artifact = { ...f.artifact, format: 'tar.xz', entry: 'runtime/bin/ffmpeg', archiveBytes: archive.length, archiveSha256: sha(archive) }
  const options = { ...f.options, artifacts: { [process.platform + '-' + process.arch]: artifact }, fetchImpl: async () => new Response(archive) }
  assert.deepEqual(await readFile(await ensureFfmpeg(options)), f.binary)
})

test('independent plugin processes share one atomic cold installation', async t => {
  const f = await fixture(t)
  const counter = join(f.directory, 'requests'), helper = join(f.directory, 'worker.mjs')
  const moduleUrl = new URL('../src/runtime/ffmpeg-runtime.mjs', import.meta.url).href
  await writeFile(helper, `import {appendFile} from 'node:fs/promises';
    import {ensureFfmpeg} from ${JSON.stringify(moduleUrl)};
    await ensureFfmpeg({...${JSON.stringify(f.options)},probe:()=>true,fetchImpl:async()=>{
      await appendFile(${JSON.stringify(counter)},'x');
      await new Promise(resolve=>setTimeout(resolve,150));
      return new Response(Buffer.from(${JSON.stringify(Buffer.from(f.archive).toString('base64'))},'base64'));
    }});`)
  const child = () => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [helper], { stdio: 'ignore' })
    p.on('error', reject)
    p.on('exit', code => code === 0 ? resolve() : reject(Error('isolated installer failed')))
  })
  await Promise.all([child(), child()])
  assert.equal(await readFile(counter, 'utf8'), 'x')
  assert.deepEqual(await readFile(ffmpegPath(f.options)), f.binary)
})

test('uninstall clears the whole component namespace and preserves external executables and the custom cache root', async t => {
  const f = await fixture(t)
  const target = await ensureFfmpeg({ ...f.options, fetchImpl: async () => new Response(f.archive) })
  const root = join(f.directory, 'codex-hongguo', 'runtime', 'ffmpeg')
  await writeFile(join(f.directory, 'user-file'), 'keep')
  await writeFile(join(f.directory, 'external-ffmpeg'), 'external executable')
  await mkdir(join(f.directory, 'runtime', 'ffmpeg'), { recursive: true })
  await writeFile(join(f.directory, 'runtime', 'ffmpeg', 'other-app'), 'keep')
  await writeFile(join(dirname(target), 'unfinished.archive'), 'partial')
  const result = await removeManagedFfmpeg({ ...f.options, env: { ...f.options.env, HONGGUO_FFMPEG: join(f.directory, 'external-ffmpeg') }, probe: () => assert.fail('uninstall must not execute media'), fetchImpl: () => assert.fail('uninstall must not download') })
  assert.equal(result.removed, 1)
  assert.equal(isFfmpegReady(f.options), false)
  await assert.rejects(lstat(root), { code: 'ENOENT' })
  assert.equal(await readFile(join(f.directory, 'user-file'), 'utf8'), 'keep')
  assert.equal(await readFile(join(f.directory, 'external-ffmpeg'), 'utf8'), 'external executable')
  assert.equal(await readFile(join(f.directory, 'runtime', 'ffmpeg', 'other-app'), 'utf8'), 'keep')
  assert.equal((await removeManagedFfmpeg(f.options)).removed, 0)
})

test('uninstall leaves no corrupt binary, unknown version, installation lock or missing receipt inside its namespace', async t => {
  for (const reason of ['modified', 'unknown', 'locked', 'missing-receipt', 'receipt-mismatch']) {
    await t.test(reason, async t => {
      const f = await fixture(t)
      const target = await ensureFfmpeg({ ...f.options, fetchImpl: async () => new Response(f.archive) })
      const root = join(f.directory, 'codex-hongguo', 'runtime', 'ffmpeg')
      if (reason === 'modified') await writeFile(target, 'other-binary')
      if (reason === 'unknown') { await mkdir(join(root, 'old-version')); await writeFile(join(root, 'old-version', 'ffmpeg'), 'old component') }
      if (reason === 'locked') await mkdir(dirname(target) + '.lock')
      if (reason === 'missing-receipt') await rm(target + '.json')
      if (reason === 'receipt-mismatch') await writeFile(target + '.json', '{}')
      assert.equal((await removeManagedFfmpeg(f.options)).removed, 1)
      await assert.rejects(lstat(root), { code: 'ENOENT' })
    })
  }
})

test('uninstall deletes links inside its namespace and leaves every external link target intact', { skip: process.platform === 'win32' }, async t => {
  for (const item of ['root', 'directory', 'binary', 'receipt']) {
    await t.test(item, async t => {
      const f = await fixture(t)
      const target = await ensureFfmpeg({ ...f.options, fetchImpl: async () => new Response(f.archive) })
      const root = join(f.directory, 'codex-hongguo', 'runtime', 'ffmpeg')
      const source = item === 'root' ? root : item === 'directory' ? dirname(target) : item === 'binary' ? target : target + '.json'
      const moved = join(f.directory, 'external-copy')
      await rename(source, moved)
      await symlink(moved, source)
      const externalBinary = item === 'root' ? join(moved, f.artifact.archiveSha256.slice(0, 16), process.platform + '-' + process.arch, 'ffmpeg') : item === 'directory' ? join(moved, 'ffmpeg') : moved
      const before = await readFile(externalBinary)
      assert.equal((await removeManagedFfmpeg(f.options)).removed, 1)
      await assert.rejects(lstat(root), { code: 'ENOENT' })
      assert.deepEqual(await readFile(externalBinary), before)
    })
  }
})

test('a substituted ancestor outside the component namespace fails cleanup without touching the external tree', { skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const target = await ensureFfmpeg({ ...f.options, fetchImpl: async () => new Response(f.archive) })
  const parent = join(f.directory, 'codex-hongguo', 'runtime'), outside = join(f.directory, 'external-runtime')
  await rename(parent, outside)
  await symlink(outside, parent)
  await assert.rejects(removeManagedFfmpeg(f.options), /清理失败/)
  assert.deepEqual(await readFile(target), f.binary)
})
