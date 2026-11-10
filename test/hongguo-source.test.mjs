import test from 'node:test'
import assert from 'node:assert/strict'
import { HongguoSource } from '../src/server/sources/hongguo.mjs'
import { filePlayback } from '../src/server/sources/contracts.mjs'

const model = codec => ({ playback: { streams: [{ url: 'https://fixture.qznovelvod.com/media.mp4', codec }] } })

test('Hongguo offers the SDK backup media address with the same authorization', () => {
  const result = filePlayback({ playback: { protected: true, streams: [{
    url: 'https://primary.qznovelvod.com/media.mp4', backup_url: 'https://backup.qznovelvod.com/media.mp4', codec: 'bytevc1',
  }, { url: 'https://another.qznovelvod.com/another-encoding.mp4', codec: 'bytevc1' }] }, contentKey: { key: '0'.repeat(32) } })
  assert.equal(result.candidates.length, 2)
  assert.equal(new URL(result.candidates[1].url).hostname, 'backup.qznovelvod.com')
  assert.equal(result.candidates[0].encryption.key === result.candidates[1].encryption.key, true)
  assert.deepEqual(result.candidates[0].backupURLs, [result.candidates[1].url])
  assert.deepEqual(result.candidates[1].backupURLs, [result.candidates[0].url])
})

test('Hongguo prefers a standard codec when a model also offers ByteVC2', () => {
  const result = filePlayback({ playback: { streams: [...model('bytevc2').playback.streams, ...model('bytevc1').playback.streams] } })
  assert.equal(result.candidates[0].codec, 'bytevc1')
})

test('Hongguo refreshes a ByteVC2-only model once and uses the compatible result', async () => {
  const source = new HongguoSource('/unused')
  let calls = 0
  source.sdkCall = async () => model(++calls === 1 ? 'bytevc2' : 'bytevc1')
  const result = await source.resolvePlayback('7100000000000201')
  assert.equal(calls, 2)
  assert.equal(result.candidates[0].codec, 'bytevc1')
})

test('Hongguo bounds codec refreshes and reports persistent incompatibility', async () => {
  const source = new HongguoSource('/unused')
  let calls = 0
  source.sdkCall = async () => { calls++; return model('bytevc2') }
  await assert.rejects(source.resolvePlayback('7100000000000201'), error => error.code === 'UNSUPPORTED_CODEC')
  assert.equal(calls, 2)
})

test('Hongguo codec recovery does not retry an authentication denial', async () => {
  const source = new HongguoSource('/unused')
  let calls = 0
  source.sdkCall = async () => { calls++; throw Object.assign(Error('fixture denial'), { code: 'AUTHENTICATION_REQUIRED' }) }
  await assert.rejects(source.resolvePlayback('7100000000000201'), error => error.code === 'AUTHENTICATION_REQUIRED')
  assert.equal(calls, 1)
})
