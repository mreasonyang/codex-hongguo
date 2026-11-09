import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const code = transformSync(readFileSync(new URL('../src/ui/dash-stream.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code
const flush = async () => { for (let i = 0; i < 150; i++) await Promise.resolve() }
function fixture(t) {
  const requested = [], revoked = [], failures = [], buffers = []
  let source, gate
  class Buffer extends EventTarget {
    updating = false; ranges = []; aborted = 0
    get buffered() { const ranges = this.ranges; return { length: ranges.length, start: i => ranges[i][0], end: i => ranges[i][1] } }
    appendBuffer(bytes) {
      const name = new TextDecoder().decode(bytes)
      if (name.endsWith('.m4s')) {
        const position = Number(/-(\d+)\./.exec(name)[1]) * 5
        this.ranges.push([position, position + 5])
        this.ranges.sort((a, b) => a[0] - b[0])
        this.ranges = this.ranges.reduce((merged, range) => {
          const previous = merged.at(-1)
          if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1])
          else merged.push(range)
          return merged
        }, [])
      }
      this.updating = true
      queueMicrotask(() => { this.updating = false; this.dispatchEvent(new Event('updateend')) })
    }
    remove(a, b) {
      this.ranges = this.ranges.flatMap(([x, y]) => y <= a || x >= b ? [[x, y]] :
        [...(x < a ? [[x, a]] : []), ...(y > b ? [[b, y]] : [])])
      queueMicrotask(() => this.dispatchEvent(new Event('updateend')))
    }
    abort() { this.aborted++; this.dispatchEvent(new Event('updateend')) }
  }
  class Source extends EventTarget {
    static isTypeSupported() { return true }
    readyState = 'open'; duration = 0
    constructor() { super(); source = this }
    addSourceBuffer() { const buffer = new Buffer(); buffers.push(buffer); return buffer }
    endOfStream() { this.readyState = 'ended' }
  }
  const context = vm.createContext({ module: { exports: {} }, Event, URL: { createObjectURL: () => 'blob:test', revokeObjectURL: url => revoked.push(url) },
    MediaSource: Source, atob: s => globalThis.Buffer.from(s, 'base64').toString('binary'),
    require: () => ({ call: async (name, args) => {
      assert.equal(name, 'read_panel_chunk'); requested.push(args.asset)
      if (gate) await gate
      const bytes = globalThis.Buffer.from(args.asset)
      return { size: bytes.length, bytes: bytes.toString('base64') }
    } }),
  })
  vm.runInContext(code, context)
  const video = Object.assign(new EventTarget(), { paused: true, currentTime: 0, src: '', plays: 0,
    play() { this.plays++; this.paused = false } })
  const manifest = JSON.stringify({ version: 1, duration: 1200, tracks: ['video', 'audio'].map(name => ({
    mime: name + '/mp4; codecs="' + (name === 'video' ? 'avc1.64001e' : 'mp4a.40.2') + '"',
    initialization: name + '-init.mp4', segments: Array.from({ length: 240 }, (_, i) => ({
      asset: name + '-' + String(i).padStart(5, '0') + '.m4s', time: i * 5, duration: 5,
    })),
  })) })
  let ended = 0
  const close = context.module.exports.dashStream(video, 'episode', 'opaque-stream', manifest, reason => failures.push(reason), () => ended++, 600)
  t.after(close)
  return { requested, video, source, close, failures, buffers, revoked, ended: () => ended,
    block: () => { let release; gate = new Promise(r => { release = r }); return () => { gate = undefined; release() } } }
}
test('deep resume reads initialization and nearby fragments, never the intervening ten minutes', async t => {
  const f = fixture(t); f.source.dispatchEvent(new Event('sourceopen')); await flush()
  assert.equal(f.failures.length, 0)
  const segments = f.requested.filter(name => name.endsWith('.m4s'))
  assert.ok(segments.length >= 2 && segments.length <= 8)
  assert.ok(segments.every(name => /-0012[0-3]\.m4s$/.test(name)))
  assert.equal(f.source.duration, 1200)
  assert.equal(f.video.plays, 0, 'the loader must never own autoplay')
  f.video.currentTime = 600
  const count = f.requested.length
  f.video.dispatchEvent(new Event('timeupdate')); await flush()
  assert.equal(f.requested.length, count, 'a covered/paused video does not keep downloading')
})
test('seeking fetches only the requested window, bounds buffered data, and does not finish at an intermediate buffer edge', async t => {
  const f = fixture(t); f.source.dispatchEvent(new Event('sourceopen')); await flush()
  f.video.currentTime = 30; f.video.dispatchEvent(new Event('seeking')); await flush()
  assert.equal(f.failures.length, 0)
  assert.ok(f.requested.some(name => name === 'video-00006.m4s'))
  assert.ok(!f.requested.some(name => name === 'video-00050.m4s'))
  assert.ok(f.buffers.every(buffer => buffer.ranges.every(([a, b]) => a >= 6 && b <= 78)))
  f.video.paused = false; f.video.currentTime = 55
  f.video.dispatchEvent(new Event('timeupdate')); await flush()
  f.video.paused = true; f.video.currentTime = 30
  f.video.dispatchEvent(new Event('seeking')); await flush()
  assert.equal(f.requested.filter(name => name === 'video-00006.m4s').length, 2,
    'seeking back must restore even a partially evicted fragment')
  f.video.dispatchEvent(new Event('ended'))
  assert.equal(f.ended(), 0)
  f.video.currentTime = 1199; f.video.dispatchEvent(new Event('seeking')); await flush()
  for (let i = 0; f.source.readyState !== 'ended' && i < 10; i++) await flush()
  assert.deepEqual(f.failures, [])
  assert.equal(f.source.readyState, 'ended')
  f.video.dispatchEvent(new Event('ended'))
  assert.equal(f.ended(), 1)
})
test('closing a loading stream ignores late fragment responses, revokes its blob and never revives playback', async t => {
  const f = fixture(t), release = f.block()
  f.source.dispatchEvent(new Event('sourceopen')); await flush()
  assert.equal(f.requested.length, 2)
  f.close(); release(); await flush()
  assert.equal(f.requested.length, 2)
  assert.equal(f.buffers.flatMap(buffer => buffer.ranges).length, 0)
  assert.equal(f.failures.length, 0)
  assert.equal(f.video.plays, 0)
  assert.deepEqual(f.revoked, ['blob:test'])
})
