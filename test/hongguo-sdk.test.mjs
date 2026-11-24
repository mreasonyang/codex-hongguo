import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
import { readFile } from 'node:fs/promises'
import { createClient, memoryProfileStore } from '../dist/vendor/openhongguo/index.js'
import { HongguoSource } from '../src/server/sources/hongguo.mjs'

const response = value => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) })
const registration = { new_user: 1, device_id_str: '7100000000000001', install_id_str: '7100000000000002' }
const registered = () => ({ ...response(registration), cookies: { ttreq: 'fixture-guest-ticket' } })
const clearModel = { code: 0, data: { video_model: JSON.stringify({
  status: 10, video_id: 'fixture', media_type: 'video', video_duration: 42,
  video_list: [{ main_url: 'https://media.invalid/fixture.mp4',
    video_meta: { definition: '360p', codec_type: 'h264', vwidth: 360, vheight: 640, bitrate: 400000, size: 2000000 } }],
}) } }
const v5Path = '/novel/player/multi_video_model/player/v1'
const legacyPath = '/novel/player/video_model/v1/'
const episodeId = '7100000000000201'
const grouped = (id, model = JSON.parse(clearModel.data.video_model)) => ({
  code: 0, data: { '1004': { [id]: { video_model: model } } },
})

test('the shipped Node declarations support the calls and fields used by the adapter', () => {
  execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--strict', '--noEmit',
    '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext', 'test/fixtures/hongguo-sdk-contract.mts'],
  { stdio: 'inherit' })
})

test('the shipped SDK identifies the unmodified official upstream source', async () => {
  const source = JSON.parse(await readFile('third_party/openhongguo/source.json', 'utf8'))
  const built = JSON.parse(await readFile('dist/vendor/openhongguo/SOURCE.json', 'utf8'))
  await assert.rejects(readFile('third_party/openhongguo/source.tar.gz'), { code: 'ENOENT' })
  // The build verifies the original download. Qualification runners receive only the shipped artifacts.
  assert.deepEqual(built, source)
  assert.match(built.revision, /^[a-f0-9]{40}$/)
  assert.match(built.sourceTree, /^[a-f0-9]{40}$/)
  assert.match(built.sourceSHA256, /^[a-f0-9]{64}$/)
  assert.equal(built.releaseURL, built.repository + '/releases/tag/v' + built.upstreamVersion)
  assert.equal(built.archiveURL, 'https://codeload.github.com/beilunyang/openhongguo/tar.gz/' + built.revision)
  assert.equal(built.repository, 'https://github.com/beilunyang/openhongguo')
  assert.equal(built.sourceURL, built.repository + '/tree/' + built.revision)
  assert.deepEqual(built.modifiedFiles, [])
  const shipped = JSON.parse(await readFile('dist/vendor/openhongguo/package.json', 'utf8'))
  assert.equal(shipped.version, source.upstreamVersion)
  const files = execFileSync('tar', ['-tzf', 'dist/licenses/openhongguo-source.tar.gz'], { encoding: 'utf8' })
    .trim().split(/\r?\n/).map(path => path.slice(path.indexOf('/') + 1))
  assert.ok(files.includes('sdk/client.go'))
  assert.ok(files.includes('bindings/node/index.js'))
  assert.ok(files.includes('LICENSE'))
  assert.ok(!files.some(path => path.startsWith('signer/')))
})

test('the shipped WebAssembly signs consecutive V5 requests over their exact gzip bodies', async () => {
  const requests = []
  const client = await createClient({ profile: memoryProfileStore(), deviceResets: 0,
    transport: async request => {
      if (new URL(request.url).pathname.includes('device_register')) return registered()
      requests.push(request)
      const payload = JSON.parse(gunzipSync(request.body))
      return response(grouped(payload.mixed_video_id_map['1004'][0]))
    } })
  for (const id of ['7100000000000201', '7100000000000202']) {
    const result = await client.resolvePlayback(id)
    assert.equal(result.playback.streams.length, 1)
  }
  assert.equal(requests.length, 2)
  for (const [index, request] of requests.entries()) {
    const url = new URL(request.url)
    assert.equal(url.pathname, v5Path)
    assert.equal(request.method, 'POST')
    assert.equal(url.searchParams.get('version_code'), '74332')
    assert.equal(url.searchParams.get('ts'), null)
    assert.equal(request.headers['Content-Encoding'], 'gzip')
    assert.deepEqual(JSON.parse(gunzipSync(request.body)).mixed_video_id_map,
      { '1004': ['710000000000020' + (index + 1)] })
    assert.ok((request.headers['x-medusa']?.length || 0) > 64)
    assert.ok(Boolean(request.headers['x-helios']))
    assert.equal(request.headers['x-ss-stub'], createHash('md5').update(request.body).digest('hex').toUpperCase())
    const cookie = Object.entries(request.headers).find(([key]) => key.toLowerCase() === 'cookie')
    assert.ok(cookie)
    assert.deepEqual(cookie[1].split('; ').filter(pair => !pair.endsWith('=')).sort(), [
      'install_id=' + registration.install_id_str,
      'ttreq=fixture-guest-ticket',
    ])
    for (const name of ['x-argus', 'x-ladon', 'x-gorgon', 'authorization'])
      assert.equal(Object.keys(request.headers).some(key => key.toLowerCase() === name), false)
  }
  assert.notEqual(requests[0].headers['x-medusa'], requests[1].headers['x-medusa'])
})

test('the upstream SDK preserves catalog signing and stops on authentication errors', async () => {
  const calls = []
  const client = await createClient({ profile: memoryProfileStore(), deviceResets: 2,
    transport: async request => {
      calls.push(request)
      if (new URL(request.url).pathname.includes('device_register')) return registered()
      return { status: 401, headers: {}, body: new Uint8Array() }
    } })
  await assert.rejects(client.suggest('fixture'), error => error.code === 'AUTHENTICATION_REQUIRED')
  await assert.rejects(client.resolvePlayback('7100000000000201'), error => error.code === 'AUTHENTICATION_REQUIRED')
  assert.equal(calls.length, 3)
  assert.ok(Boolean(calls[1].headers['x-medusa']))
  assert.ok(Boolean(calls[2].headers['x-medusa']))
  assert.equal('x-argus' in calls[2].headers, false)
  assert.equal(new URL(calls[2].url).pathname, v5Path)
})

test('resolving the same episode again requests fresh playback information through the official SDK', async () => {
  let playbackRequests = 0
  const client = await createClient({ profile: memoryProfileStore(), deviceResets: 0,
    transport: async request => {
      if (new URL(request.url).pathname.includes('device_register')) return registered()
      playbackRequests++
      const model = JSON.parse(clearModel.data.video_model)
      model.video_list[0].main_url = 'https://media.invalid/' + (playbackRequests === 1 ? 'expired' : 'refreshed') + '.mp4'
      return response({ code: 0, data: { video_model: JSON.stringify(model) } })
    } })
  const source = new HongguoSource('/unused-fixture-profile')
  source.client = Promise.resolve(client)
  const before = await source.resolvePlayback('7100000000000201')
  const after = await source.resolvePlayback('7100000000000201')
  assert.equal(playbackRequests, 2)
  assert.equal(before.candidates[0].url, 'https://media.invalid/expired.mp4')
  assert.equal(after.candidates[0].url, 'https://media.invalid/refreshed.mp4')
})

test('V5 empty responses retry once before legacy fallback, while 404 falls back immediately', async t => {
  for (const status of [200, 404]) await t.test(String(status), async () => {
    const calls = []
    const client = await createClient({ profile: memoryProfileStore(), deviceResets: 0, retryAttempts: 1,
      transport: async request => {
        const path = new URL(request.url).pathname
        calls.push(path)
        if (path.includes('device_register')) return registered()
        if (path === v5Path) return { status, headers: {}, body: new Uint8Array() }
        assert.equal(path, legacyPath)
        assert.ok(request.headers['x-argus'])
        assert.equal('x-medusa' in request.headers, false)
        return response(clearModel)
      } })
    const result = await client.resolvePlayback(episodeId)
    assert.equal(result.playback.streams.length, 1)
    assert.equal(calls.filter(path => path.includes('device_register')).length, 1)
    assert.deepEqual(calls.filter(path => !path.includes('device_register')),
      [...Array(status === 200 ? 2 : 1).fill(v5Path), legacyPath])
  })
})

test('V5 terminal and malformed responses never fall back or replace the device', async t => {
  const failures = [
    [401, '', 'AUTHENTICATION_REQUIRED'], [403, '', 'AUTHENTICATION_REQUIRED'],
    [429, '', 'RATE_LIMITED'], [500, ''],
    [200, JSON.stringify({ code: 900123, message: 'synthetic rejection' })],
    [200, JSON.stringify(grouped('7100000000000999'))],
  ]
  for (const [index, [status, body, code]] of failures.entries()) await t.test(String(index), async () => {
    const calls = []
    const client = await createClient({ profile: memoryProfileStore(), deviceResets: 2, retryAttempts: 1,
      transport: async request => {
        const path = new URL(request.url).pathname
        calls.push(path)
        if (path.includes('device_register')) return registered()
        return { status, headers: {}, body: new TextEncoder().encode(body) }
      } })
    await assert.rejects(client.resolvePlayback(episodeId), error => !code || error.code === code)
    assert.equal(calls.filter(path => path.includes('device_register')).length, 1)
    assert.deepEqual(calls.filter(path => !path.includes('device_register')), [v5Path])
  })
})

test('V5 grouped models decode encrypted main and Base64 backup addresses for the existing adapter', async () => {
  const url = 'https://fixture.qznovelvod.com/media.mp4'
  const backup = 'https://backup.qznovelvod.com/media.mp4'
  const seed = Buffer.from('synthetic-playback-seed')
  const salt = Buffer.from('4dd4c2e6b83162090e52b3c7a6733ba41cb2462b829ab58a196b39db57177524' +
    'f49baf7f08e8d68d26a72e37c1a95a2f1f05a51892aef2949732b62a38aadd58', 'hex')
  const first = createHash('sha512').update(seed).digest()
  const derived = createHash('sha512').update(first).update(salt).digest()
  const cipher = createCipheriv('aes-128-cbc', derived.subarray(0, 16), derived.subarray(16, 32))
  const encoded = Buffer.concat([Buffer.from([0xa8, 0, 1, 0]), cipher.update(url), cipher.final()]).toString('base64')
  const model = JSON.parse(clearModel.data.video_model)
  model.key_seed = seed.toString('base64')
  model.video_list[0].main_url = encoded
  model.video_list[0].backup_url_2 = Buffer.from(backup).toString('base64')
  const client = await createClient({ profile: memoryProfileStore(), deviceResets: 0,
    transport: async request => new URL(request.url).pathname.includes('device_register')
      ? registered() : response(grouped(episodeId, model)) })
  const source = new HongguoSource('/unused-fixture-profile')
  source.client = Promise.resolve(client)
  const result = await source.resolvePlayback(episodeId)
  assert.deepEqual(result.candidates.map(candidate => candidate.url), [url, backup])
  assert.deepEqual(result.candidates[0].backupURLs, [backup])
})
