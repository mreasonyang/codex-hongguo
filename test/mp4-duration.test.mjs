import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mp4DurationMs } from '../src/server/mp4-duration.mjs'

function box(type, payload) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(8 + payload.length)
  header.write(type, 4)
  return Buffer.concat([header, payload])
}
test('MP4 movie headers provide a stable full duration for both timestamp versions', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hongguo-duration-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const version of [0, 1]) {
    const header = Buffer.alloc(32)
    header[0] = version
    header.writeUInt32BE(1000, version === 0 ? 12 : 20)
    if (version === 0) header.writeUInt32BE(120500, 16)
    else header.writeBigUInt64BE(120500n, 24)
    const path = join(root, 'movie-' + version + '.mp4')
    await writeFile(path, Buffer.concat([box('ftyp', Buffer.alloc(8)), box('moov', box('mvhd', header))]))
    assert.equal(await mp4DurationMs(path), 120500)
  }
})
test('invalid box bounds, unknown headers and zero timescales fall back without inventing a duration', async t => {
  const root = await mkdtemp(join(tmpdir(), 'hongguo-duration-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const large = Buffer.alloc(16)
  large.writeUInt32BE(1); large.write('moov', 4); large.writeBigUInt64BE(2n ** 63n, 8)
  for (const [index, bytes] of [Buffer.alloc(3), large, box('moov', box('mvhd', Buffer.alloc(32))), box('free', Buffer.alloc(8))].entries()) {
    const path = join(root, String(index))
    await writeFile(path, bytes)
    assert.equal(await mp4DurationMs(path), undefined)
  }
})
