import test from 'node:test'
import assert from 'node:assert/strict'
import { trackInlineSize } from '../src/ui/inline-size.ts'

test('inline invitations shrink to their content and resend a positive collapsed height after fullscreen', t => {
  let pending, observed, inline = true, disconnected = false
  const names = ['requestAnimationFrame', 'cancelAnimationFrame', 'ResizeObserver']
  const originals = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name))
  t.after(() => names.forEach((name, i) => {
    if (originals[i]) Object.defineProperty(globalThis, name, originals[i])
    else delete globalThis[name]
  }))
  globalThis.requestAnimationFrame = fn => { pending = fn; return 1 }
  globalThis.cancelAnimationFrame = () => { pending = undefined }
  globalThis.ResizeObserver = class {
    constructor(fn) { observed = fn }
    observe() {}
    disconnect() { disconnected = true }
  }
  const card = { hidden: false, getBoundingClientRect: () => ({ height: 73.2 }) }, heights = []
  const sizing = trackInlineSize(card, () => inline, height => heights.push(height))
  const frame = () => { const run = pending; pending = undefined; run?.() }
  frame(); assert.deepEqual(heights, [74])
  card.hidden = true; observed(); frame(); assert.equal(heights.at(-1), 1)
  inline = false; observed(); frame(); assert.equal(heights.length, 2)
  inline = true; sizing.refresh(); frame(); assert.deepEqual(heights, [74, 1, 1])
  observed(); sizing.dispose(); frame(); assert.equal(heights.length, 3)
  assert.equal(disconnected, true)
})
