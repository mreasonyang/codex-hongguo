import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { zipSync } from 'fflate'
import { ensureFfmpeg, ffmpegPath, isFfmpegReady } from '../src/runtime/ffmpeg-runtime.mjs'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "红果 media '$ "))
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
  assert.deepEqual(await readdir(f.directory), ['runtime'])
  await assert.rejects(readFile(join(f.directory, 'escape')), { code: 'ENOENT' })
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
