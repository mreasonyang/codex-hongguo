import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/server/store.mjs'
import { Service } from '../src/server/service.mjs'
import { BrowserServer } from '../src/server/browser.mjs'

test('upgrading deletes obsolete cover settings from storage while preserving hover, other preferences and progress', t => {
  const root = mkdtempSync(join(tmpdir(), 'hongguo-fixed-cover-'))
  let store = new Store(root)
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  const retained = { hoverDecoyEnabled: true, volume: 0.43, searchTerms: ['都市'], futureSetting: 'preserve' }
  store.db.prepare('INSERT OR REPLACE INTO player_preferences VALUES(1,?)').run(JSON.stringify({
    ...retained, decoyUrl: 'https://example.org/notes', decoyFrameUrl: 'https://example.org/frame',
  }))
  store.db.exec('PRAGMA user_version=1')
  store.save({ seriesId: 'hg-10', episodeId: 'hg-101', title: '测试', label: '1', positionMs: 42000, durationMs: 120000 })
  const history = store.history()
  store.close()
  for (let reopen = 0; reopen < 2; reopen++) {
    store = new Store(root)
    assert.deepEqual(JSON.parse(store.db.prepare('SELECT body FROM player_preferences WHERE id=1').get().body), retained)
    assert.equal(store.preferences().hoverDecoyEnabled, true)
    assert.equal(store.preferences().coverStyle, 'random')
    assert.equal('decoyUrl' in store.preferences(), false)
    assert.equal('decoyFrameUrl' in store.preferences(), false)
    assert.deepEqual(store.history(), history)
    if (reopen === 0) store.close()
  }
})

test('built-in cover has no URL setting, display grant, embedded website or frame permission', async t => {
  const store = new Store(undefined, true), service = new Service(store, {}), browser = new BrowserServer(service)
  t.after(() => { browser.close(); store.close() })
  const scope = service.panel(service.open({}).panel)
  for (const key of ['decoyUrl', 'decoyFrameUrl']) {
    await assert.rejects(service.call(scope, 'set_preferences', { [key]: 'https://example.org/notes' }), /参数无效/)
    assert.equal(key in await service.call(scope, 'get_preferences', {}), false)
  }
  assert.equal('coverFrame' in service, false)
  assert.equal('covers' in browser, false)
  const pairing = await browser.pair({})
  const exchanged = await fetch(browser.origin + '/exchange', {
    method: 'POST', headers: { Origin: browser.origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket: new URL(pairing.url).hash.slice(1) }),
  })
  const cookie = exchanged.headers.get('set-cookie').split(';')[0], page = (await exchanged.json()).page
  const response = await fetch(browser.origin + page, { headers: { Cookie: cookie } })
  assert.equal(response.status, 200)
  const policy = response.headers.get('content-security-policy')
  assert.match(policy, /default-src 'none'/)
  assert.doesNotMatch(policy, /frame-src|127\.0\.0\.1/)
  const html = await response.text()
  assert.match(html, /id="coverStyle"/)
  assert.doesNotMatch(html, /<select\b[^>]*id="coverStyle"/)
  assert.match(html, /id="coverStyleOptions"[^>]*role="listbox"/)
  assert.doesNotMatch(html, /<select\b[^>]*id="settingsSource"/)
  assert.match(html, /id="settingsSourceOptions"[^>]*role="listbox"/)
  assert.doesNotMatch(html, /changeCover|换一页|Change page/)
  assert.doesNotMatch(html, /<iframe|decoyUrl|decoyFrameUrl|decoyWebsite|canEmbedDecoy|data-decoy-origin/)
  assert.equal((await fetch(browser.origin + '/cover/' + '0'.repeat(48))).status, 401)
})

test('cover styles default for existing users, persist across restart and reject unsupported choices', async t => {
  const root = mkdtempSync(join(tmpdir(), 'hongguo-cover-style-'))
  let store = new Store(root)
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  store.db.prepare('INSERT OR REPLACE INTO player_preferences VALUES(1,?)').run(JSON.stringify({
    hoverDecoyEnabled: true, volume: 0.43,
  }))
  assert.equal(store.preferences().coverStyle, 'random')
  for (const coverStyle of ['tasks', 'document', 'report', 'minutes', 'random']) {
    const service = new Service(store, {}), scope = service.panel(service.open({}).panel)
    await service.call(scope, 'set_preferences', { coverStyle })
    store.close(); store = new Store(root)
    assert.equal(store.preferences().coverStyle, coverStyle)
    assert.equal(store.preferences().hoverDecoyEnabled, true)
    assert.equal(store.preferences().volume, 0.43)
  }
  const service = new Service(store, {}), scope = service.panel(service.open({}).panel)
  for (const coverStyle of ['unknown', '', null, 1])
    await assert.rejects(service.call(scope, 'set_preferences', { coverStyle }), /参数无效/)
})
