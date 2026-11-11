import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createClient, memoryProfileStore } from '../dist/vendor/openhongguo/index.js'

const response = value => ({ status: 200, headers: {}, body: new TextEncoder().encode(JSON.stringify(value)) })
const registration = { new_user: 1, device_id_str: '7100000000000001', install_id_str: '7100000000000002' }
const registered = () => ({ ...response(registration), cookies: { ttreq: 'fixture-guest-ticket' } })
const clearModel = { code: 0, data: { video_model: JSON.stringify({
  status: 10, video_id: 'fixture', media_type: 'video', video_duration: 42,
  video_list: [{ main_url: 'https://media.invalid/fixture.mp4',
    video_meta: { definition: '360p', codec_type: 'h264', vwidth: 360, vheight: 640, bitrate: 400000, size: 2000000 } }],
}) } }

test('the shipped SDK identifies the bundled patched source', async () => {
  const source = JSON.parse(await readFile('third_party/openhongguo/source.json', 'utf8'))
  const built = JSON.parse(await readFile('dist/vendor/openhongguo/SOURCE.json', 'utf8'))
  const digest = createHash('sha256').update(await readFile('third_party/openhongguo/source.tar.gz')).digest('hex')
  assert.equal(digest, source.sourceSHA256)
  assert.deepEqual(built, source)
  assert.equal(built.revision, 'bed14595d35b02e0d550270621812ca7386c4108')
})

test('the shipped WebAssembly signs consecutive playback requests with Argus and Ladon', async () => {
  const requests = []
  const client = await createClient({ profile: memoryProfileStore(), deviceResets: 0,
    transport: async request => {
      if (new URL(request.url).pathname.includes('device_register')) return registered()
      requests.push(request)
      return response(clearModel)
    } })
  for (const id of ['7100000000000201', '7100000000000202']) {
    const result = await client.resolvePlayback(id)
    assert.equal(result.playback.streams.length, 1)
  }
  assert.equal(requests.length, 2)
  for (const request of requests) {
    assert.equal(request.method, 'POST')
    assert.ok((request.headers['x-argus']?.length || 0) > 64)
    assert.ok((request.headers['x-ladon']?.length || 0) > 8)
    assert.equal('x-medusa' in request.headers, false)
    assert.ok(Boolean(request.headers['x-ss-stub']))
  }
  assert.equal(requests[0].headers['x-argus'] === requests[1].headers['x-argus'], false)
})

test('the patched SDK preserves catalog signing and stops on authentication errors', async () => {
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
  assert.equal('x-medusa' in calls[2].headers, false)
})
