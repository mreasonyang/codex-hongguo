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

test('real browser responses bootstrap the cover and allow only the configured frame origin', async t => {
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
  assert.match(response.headers.get('content-security-policy'), /frame-src https:\/\/example.org;/)
  assert.match(await response.text(), /data-hover-decoy="on" data-decoy-origin="https:\/\/example.org"/)
  store.setPreferences({ decoyUrl: '' })
  assert.match((await get()).headers.get('content-security-policy'), /frame-src 'none';/)
})
