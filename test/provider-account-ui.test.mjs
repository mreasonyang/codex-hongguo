import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const code = transformSync(readFileSync(new URL('../src/ui/provider-account.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' }).code
const flush = async () => { for (let i = 0; i < 60; i++) await Promise.resolve() }
function fixture() {
  const elements = new Map(), timers = new Map(), requests = [], revoked = [], updates = []
  let next = 0
  const document = { scrollingElement: { scrollTop: 160 }, activeElement: undefined, createElement() {
    return { hidden: false, disabled: false, textContent: '', dataset: {}, children: [], attributes: {},
      append(...children) { this.children.push(...children) }, replaceChildren(...children) { this.children = children },
      setAttribute(name, value) { this.attributes[name] = value }, removeAttribute(name) { delete this[name] },
      focus() { document.activeElement = this },
    }
  }, getElementById(id) {
    if (!elements.has(id)) elements.set(id, this.createElement())
    return elements.get(id)
  } }
  const get = id => document.getElementById(id)
  get('accountPage').hidden = true
  const state = { status: { status: 'signed-out' }, statuses: {}, poll: { status: 'waiting' },
    start: { status: 'waiting', loginId: 'opaque-session', svg: '<svg/>', expiresAt: Date.now() + 180000 } }
  const call = async (name, args) => {
    requests.push({ name, args })
    if (name === 'get_provider_auth') return state.statuses[args.source] ?? state.status
    if (name === 'start_provider_login') return state.start
    if (name === 'poll_provider_login') return state.poll
    if (name === 'logout_provider') return { status: 'signed-out' }
    return { status: 'cancelled' }
  }
  const exports = {}, context = vm.createContext({ module: { exports }, exports, Blob, Date, document,
    URL: { createObjectURL: () => 'blob:synthetic-qr', revokeObjectURL: url => revoked.push(url) },
    setTimeout(fn, ms) { timers.set(++next, { fn, ms }); return next }, clearTimeout(id) { timers.delete(id) },
    require(name) { if (name === './api') return { call }; if (name === './locale') return { tr: s => s }; throw Error('unexpected import') },
  })
  vm.runInContext(code, context)
  const account = new context.module.exports.ProviderAccount(async (source, signedIn) => { updates.push({ source, signedIn }) })
  return { account, get, state, requests, revoked, updates, document,
    row: (index = 0) => get('accountRows').children[index],
    status: (index = 0) => get('accountRows').children[index].children[1].children[1].textContent,
    async show(providers = [{ id: 'bilibili', name: '哔哩哔哩' }]) { account.sync(providers); await flush() },
    async tick(ms) {
      const entry = [...timers].find(([, timer]) => timer.ms === ms)
      assert.ok(entry, 'expected timer'); timers.delete(entry[0]); await entry[1].fn(); await flush()
    },
  }
}

test('settings show compact provider rows; QR appears only after choosing an account', async () => {
  const f = fixture(); await f.show()
  assert.equal(f.get('providerAccount').hidden, false)
  assert.equal(f.status(), '未登录')
  assert.equal(f.get('accountPage').hidden, true)
  assert.equal(f.requests.some(r => r.name === 'start_provider_login'), false)
  await f.account.open('bilibili')
  assert.equal(f.get('settingsMain').hidden, true)
  assert.equal(f.get('accountPage').hidden, false)
  assert.equal(f.get('accountTitle').textContent, '哔哩哔哩')
  assert.equal(f.get('accountQr').src, 'blob:synthetic-qr')
  assert.equal(f.get('accountQrArea').hidden, false)
  f.account.hide()
})

test('successful QR sign-in returns to settings, preserves provider name and shows identity and membership', async () => {
  const f = fixture(); await f.show(); await f.account.open('bilibili')
  f.state.poll = { status: 'scanned' }; await f.tick(2000)
  assert.match(f.get('accountStatus').textContent, /手机上确认/)
  f.state.poll = { status: 'signed-in', name: 'Test account', vip: true }; await f.tick(2200)
  assert.equal(f.get('accountPage').hidden, true)
  assert.equal(f.get('settingsMain').hidden, false)
  assert.equal(f.row().children[1].children[0].textContent, '哔哩哔哩')
  assert.equal(f.status(), 'Test account · 大会员')
  assert.equal(f.document.activeElement, f.row())
  assert.deepEqual(f.updates, [{ source: 'bilibili', signedIn: true }])
  assert.equal(f.revoked.length, 1)
  await f.account.open('bilibili')
  assert.equal(f.get('accountName').textContent, 'Test account')
  assert.equal(f.get('accountLogin').hidden, true)
  assert.equal(f.get('accountLogout').hidden, false)
  assert.equal(f.requests.filter(r => r.name === 'start_provider_login').length, 1)
  await f.account.logout()
  assert.equal(f.get('accountPage').hidden, true)
  assert.equal(f.status(), '未登录')
  assert.deepEqual(f.updates, [{ source: 'bilibili', signedIn: true }, { source: 'bilibili', signedIn: false }])
  assert.equal(f.requests.some(request => JSON.stringify(request).includes('cookie')), false)
  f.account.hide()
})

for (const dismiss of ['back', 'cancel', 'hide']) test(`${dismiss} cancels QR, restores the parent view and ignores a late login response`, async () => {
  const f = fixture(); await f.show(); await f.account.open('bilibili')
  let resolve
  f.state.poll = new Promise(done => { resolve = done })
  const pending = f.tick(2000); await flush()
  f.document.scrollingElement.scrollTop = 0
  if (dismiss === 'hide') f.account.hide()
  else f.get(dismiss === 'back' ? 'accountBack' : 'accountCancel').onclick()
  resolve({ status: 'signed-in', name: 'Late account' }); await pending
  assert.equal(f.get('accountPage').hidden, true)
  assert.equal(f.get('settingsMain').hidden, false)
  assert.equal(f.get('accountQr').src, undefined)
  assert.deepEqual(f.updates, [])
  assert.equal(f.requests.filter(r => r.name === 'cancel_provider_login').length, 1)
  if (dismiss !== 'hide') {
    assert.equal(f.document.scrollingElement.scrollTop, 160)
    assert.equal(f.document.activeElement, f.row())
    assert.equal(f.status(), '未登录')
  }
  f.account.hide()
})

test('late QR creation is cancelled after leaving the page and expiration permits refreshing', async () => {
  const f = fixture(); await f.show()
  let resolve
  f.state.start = new Promise(done => { resolve = done })
  const pending = f.account.open('bilibili'); f.account.back()
  resolve({ status: 'waiting', loginId: 'late-session', svg: '<svg/>', expiresAt: Date.now() + 180000 })
  await pending
  assert.equal(f.get('accountQr').src, undefined)
  assert.ok(f.requests.some(r => r.name === 'cancel_provider_login' && r.args.loginId === 'late-session'))
  f.account.hide()
  const expired = fixture(); await expired.show(); await expired.account.open('bilibili')
  expired.state.poll = { status: 'expired' }; await expired.tick(2000)
  assert.match(expired.get('accountStatus').textContent, /已过期/)
  assert.equal(expired.get('accountQrArea').hidden, true)
  await expired.account.start()
  assert.equal(expired.get('accountQrArea').hidden, false)
  expired.account.hide()
})

test('multiple providers keep their own summaries and auth calls, while settings sync preserves the active login', async () => {
  const f = fixture(), providers = [{ id: 'bilibili', name: '哔哩哔哩' }, { id: 'other', name: 'Other source' }]
  f.state.statuses.other = { status: 'signed-in', name: 'Other account' }
  await f.show(providers)
  assert.equal(f.status(1), 'Other account · 已登录')
  await f.account.open('bilibili')
  for (let i = 0; i < 5; i++) f.account.sync(providers)
  assert.equal(f.requests.filter(r => r.name === 'start_provider_login').length, 1)
  assert.equal(f.get('accountQrArea').hidden, false)
  f.account.back(); await f.account.open('other')
  assert.equal(f.get('accountTitle').textContent, 'Other source')
  await f.account.logout()
  assert.equal(f.requests.find(r => r.name === 'logout_provider').args.source, 'other')
  assert.equal(f.status(), '未登录')
  assert.equal(f.status(1), '未登录')
  f.account.hide()
})

test('a status request started before login cannot overwrite the successful identity after returning', async () => {
  const f = fixture(); await f.show()
  let resolve
  f.state.status = new Promise(done => { resolve = done })
  const old = f.account.refresh()
  await f.account.open('bilibili')
  f.state.poll = { status: 'signed-in', name: 'Fresh account' }; await f.tick(2000)
  resolve({ status: 'signed-out' }); await old
  assert.equal(f.status(), 'Fresh account · 已登录')
  f.account.hide()
})

test('removing an active provider cancels its QR and hiding settings ignores a late summary', async () => {
  const f = fixture(); await f.show(); await f.account.open('bilibili')
  f.account.sync([])
  assert.equal(f.get('providerAccount').hidden, true)
  assert.equal(f.get('accountPage').hidden, true)
  assert.ok(f.requests.some(r => r.name === 'cancel_provider_login'))
  let resolve
  f.state.status = new Promise(done => { resolve = done })
  f.account.sync([{ id: 'bilibili', name: '哔哩哔哩' }]); f.account.hide()
  resolve({ status: 'signed-in', name: 'Late summary' }); await flush()
  assert.equal(f.get('providerAccount').hidden, true)
  assert.equal(f.get('accountRows').children.length, 0)
})
