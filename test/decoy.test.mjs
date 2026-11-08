import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeDecoyUrl, decoyOrigin, decoyDocument } from '../src/server/decoy.mjs'
import { Store } from '../src/server/store.mjs'
import { Service } from '../src/server/service.mjs'
import { BrowserServer } from '../src/server/browser.mjs'

test('custom cover URLs normalize without allowing credentials, executable schemes or CSP delimiters', () => {
  assert.equal(normalizeDecoyUrl('  '), '')
  assert.equal(normalizeDecoyUrl(' https://例子.中国/笔记 '), 'https://xn--fsqu00a.xn--fiqs8s/%E7%AC%94%E8%AE%B0')
  assert.equal(decoyOrigin('http://[::1]:8080/notes'), 'http://[::1]:8080')
  for (const url of ['data:text/html,test', 'javascript:void(0)', 'file:///tmp/notes', 'https://name:pass@example.org',
    'https://example.org;style-src', "https://example.org'", 'a'.repeat(2049)]) {
    assert.throws(() => normalizeDecoyUrl(url))
    assert.equal(decoyOrigin(url), '')
  }
  const html = decoyDocument('<html data-hover-decoy="off">', { hoverDecoyEnabled: true, decoyUrl: 'https://example.org/notes?view=work' })
  assert.match(html, /data-decoy-origin="https:\/\/example.org"/)
  assert.doesNotMatch(html, /view=work/)
})

test('saved cover URLs update only the local display frame, with exact target policies and revoked old grants', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hongguo-decoy-'))
  const store = new Store(root), service = new Service(store, {}), browser = new BrowserServer(service)
  t.after(() => { browser.close(); store.close(); rmSync(root, { recursive: true, force: true }) })
  store.setPreferences({ hoverDecoyEnabled: true, decoyUrl: 'https://example.org/work' })
  const pairing = await browser.pair({})
  const exchanged = await fetch(browser.origin + '/exchange', {
    method: 'POST', headers: { Origin: browser.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: new URL(pairing.url).hash.slice(1) }),
  })
  const cookie = exchanged.headers.get('set-cookie').split(';')[0], page = (await exchanged.json()).page
  const get = () => fetch(browser.origin + page, { headers: { Cookie: cookie } })
  const response = await get()
  assert.equal(response.status, 200)
  assert.ok(response.headers.get('content-security-policy').includes('frame-src ' + browser.origin + ';'))
  assert.ok((await response.text()).includes('data-hover-decoy="on" data-decoy-origin="' + browser.origin + '"'))
  const save = async patch => {
    const response = await fetch(browser.origin + page + 'api/set_preferences', {
      method: 'POST', headers: { Cookie: cookie, Origin: browser.origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    assert.equal(response.status, 200)
    return response.json()
  }
  const first = await save({ decoyUrl: 'https://example.org/notes?view=work&name=__NONCE__' })
  assert.equal(new URL(first.decoyFrameUrl).origin === browser.origin, true)
  const cover = await fetch(first.decoyFrameUrl)
  assert.equal(cover.status, 200)
  const policy = cover.headers.get('content-security-policy')
  assert.match(policy, /frame-src https:\/\/example.org;/)
  assert.match(policy, /default-src 'none'/)
  const html = await cover.text()
  assert.match(html, /view=work&amp;name=__NONCE__/)
  assert.doesNotMatch(html, /<script/)
  assert.equal(html.includes(new URL(first.decoyFrameUrl).pathname), false)
  const second = await save({ decoyUrl: 'https://notes.example.net/next' })
  assert.equal(second.decoyFrameUrl === first.decoyFrameUrl, false)
  const changed = await fetch(second.decoyFrameUrl)
  assert.equal(changed.status, 200)
  assert.match(changed.headers.get('content-security-policy'), /frame-src https:\/\/notes.example.net;/)
  assert.equal((await fetch(first.decoyFrameUrl)).status, 404)
  assert.equal('decoyFrameUrl' in store.preferences(), false, 'display capabilities must stay out of the preferences database')
  const repeated = await save({ volume: 0.5 })
  assert.equal(repeated.decoyFrameUrl === second.decoyFrameUrl, true, 'unrelated settings must not reload the cover')
  const cleared = await save({ decoyUrl: '' })
  assert.equal(typeof cleared.decoyFrameUrl, 'undefined')
  assert.equal((await fetch(second.decoyFrameUrl)).status, 404)
  assert.equal((await fetch(browser.origin + '/cover/' + '0'.repeat(48))).status, 404)
})
