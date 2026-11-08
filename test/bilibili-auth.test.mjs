import test from 'node:test'
import { defer } from './cleanup.mjs'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, readFile, mkdir, writeFile, symlink, link } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BilibiliSource } from '../src/server/sources/bilibili.mjs'
import { BilibiliCredentials } from '../src/server/sources/bilibili-auth.mjs'
import { ProviderRegistry, builtins } from '../src/server/providers/registry.mjs'
import { Store } from '../src/server/store.mjs'
import { Catalog } from '../src/server/catalog.mjs'
import { Service } from '../src/server/service.mjs'

async function fixture(t, { root, cookie = '' } = {}) {
  root ??= await mkdtemp(join(tmpdir(), 'bilibili-auth-'))
  defer(t, () => rm(root, { recursive: true, force: true }))
  const controller = new AbortController(), calls = [], options = { code: 86101, now: 1000, login: true }
  const context = { dataDir: root, signal: controller.signal, mediaFetcher: headers => {
    assert.equal(Object.keys(headers).some(key => key.toLowerCase() === 'cookie'), false)
    return async () => { throw Error('unused') }
  }, async fetch(input, init) {
    const url = new URL(input); calls.push({ url, init })
    if (options.fetch) return options.fetch(url, init)
    if (url.pathname.endsWith('/generate')) return Response.json({ code: 0, data: {
      qrcode_key: 'synthetic-qr-key', url: 'https://passport.bilibili.com/qrcode/h5/login?oauthKey=synthetic-qr-key',
    } })
    if (url.pathname.endsWith('/poll')) {
      const headers = new Headers()
      if (options.code === 0 && !options.ticket && !options.noCookie) {
        headers.append('set-cookie', 'SESSDATA=synthetic-session; Path=/; HttpOnly; Domain=.bilibili.com')
        headers.append('set-cookie', 'bili_jct=synthetic-csrf; Path=/; Domain=.bilibili.com')
        headers.append('set-cookie', 'unrelated=ignore-me; Path=/')
      }
      return Response.json({ code: 0, data: { code: options.code,
        url: options.ticket || '', refresh_token: 'synthetic-unused-refresh' } }, { headers })
    }
    if (url.hostname === 'passport.biligame.com') {
      assert.equal(init.followRedirects, false)
      assert.equal(init.headers.Cookie, undefined)
      return new Response('', { status: 302, headers: {
        'set-cookie': 'SESSDATA=synthetic-ticket-session; Domain=.bilibili.com; HttpOnly',
        location: 'https://www.bilibili.com/',
      } })
    }
    if (url.pathname === '/x/web-interface/nav') return Response.json({ code: 0, data: {
      isLogin: options.login, uname: 'Test account', vipStatus: 1, unexpected: 'do-not-expose',
    } })
    throw Error('unexpected request')
  } }
  const provider = new BilibiliSource(context, { cookie })
  provider.auth.now = () => options.now
  defer(t, () => provider.dispose())
  return { root, provider, auth: provider.auth, controller, context, calls, options,
    advance() { options.now += 2200 } }
}
const noSecrets = value => {
  const serialized = JSON.stringify(value)
  for (const part of ['synthetic-session','synthetic-csrf','synthetic-ticket-session','synthetic-qr-key',
    'synthetic-unused-refresh','SESSDATA','set-cookie','unexpected','do-not-expose']) assert.equal(serialized.includes(part), false)
}
test('anonymous auth status is lazy and QR sessions use the pinned SDK without exposing upstream credentials', async t => {
  const f = await fixture(t), owner = {}
  assert.deepEqual(await f.auth.status(), { status: 'signed-out' })
  assert.equal(f.provider.sdk, undefined)
  const qr = await f.auth.start(owner)
  assert.equal(qr.status, 'waiting'); assert.match(qr.svg, /^<svg/); noSecrets(qr)
  assert.equal((await f.auth.poll({}, qr.loginId)).status, 'cancelled')
  assert.equal((await f.auth.poll(owner, qr.loginId)).status, 'waiting')
  f.options.code = 86090; f.advance()
  assert.equal((await f.auth.poll(owner, qr.loginId)).status, 'scanned')
  f.options.code = 0; f.advance()
  const state = await f.auth.poll(owner, qr.loginId)
  assert.deepEqual(state, { status: 'signed-in', name: 'Test account', vip: true }); noSecrets(state)
  assert.equal(f.auth.sessions.size, 0)
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith('/nav')).length, 1)
  assert.equal(f.calls.find(c => c.url.pathname.endsWith('/nav')).init.headers.Cookie.includes('SESSDATA='), true)
  assert.equal(f.calls.filter(c => c.url.hostname === 'passport.bilibili.com').every(c => !c.init.headers.Cookie), true)
  assert.equal(f.auth.cookie().includes('unrelated'), false)
  const stored = JSON.parse(await readFile(join(f.root,'account/session.json'),'utf8'))
  assert.equal(Object.keys(stored).sort().join(','), 'cookie,revision,version')
  if (process.platform !== 'win32') {
    assert.equal((await stat(join(f.root,'account/session.json'))).mode & 0o777, 0o600)
    assert.equal((await stat(join(f.root,'account'))).mode & 0o777, 0o700)
  }
})
test('new crossDomain tickets collect passport response cookies without sending credentials to SSO redirects', async t => {
  const f = await fixture(t), owner = {}
  f.options.code = 0
  f.options.ticket = 'https://passport.biligame.com/x/passport-login/web/crossDomain?ticket=synthetic-ticket'
  const qr = await f.auth.start(owner)
  const state = await f.auth.poll(owner, qr.loginId)
  assert.equal(state.status, 'signed-in'); noSecrets(state)
  assert.equal(f.calls.filter(c => c.url.hostname === 'passport.biligame.com').length, 1)
  assert.equal(f.calls.some(c => c.url.hostname === 'www.bilibili.com'), false)
})
test('untrusted SSO and QR URLs are rejected before any credential can be sent', async t => {
  for (const ticket of ['https://evil.test/crossDomain?ticket=synthetic',
    'http://passport.biligame.com/crossDomain', 'https://passport.biligame.com/other',
    'https://passport.biligame.com@evil.test/crossDomain']) {
    const f = await fixture(t), owner = {}; f.options.code=0; f.options.ticket=ticket
    const qr=await f.auth.start(owner)
    await assert.rejects(f.auth.poll(owner,qr.loginId), /登录暂时不可用/)
    assert.equal(f.calls.some(c => c.url.href === ticket), false)
    assert.equal(f.auth.cookie(),'')
  }
  const f=await fixture(t)
  f.options.fetch=async()=>Response.json({code:0,data:{url:'https://evil.test/login',qrcode_key:'synthetic'}})
  await assert.rejects(f.auth.start({}), /登录暂时不可用/)
})
test('pending polls are coalesced, bounded by TTL and cancellation, and cannot resurrect a signed-out account', async t => {
  const f = await fixture(t), owner = {}, qr = await f.auth.start(owner)
  await f.auth.poll(owner, qr.loginId); await f.auth.poll(owner, qr.loginId)
  assert.equal(f.calls.filter(c => c.url.pathname.endsWith('/poll')).length, 1)
  f.options.now += 181000
  assert.equal((await f.auth.poll(owner, qr.loginId)).status, 'expired')
  const next=await f.auth.start(owner)
  let complete
  const wait=new Promise(resolve=>{complete=resolve})
  f.options.fetch=async()=>wait
  const pending=f.auth.poll(owner,next.loginId)
  await Promise.resolve(); f.auth.logout()
  complete(Response.json({code:0,data:{code:0}}, {headers:{'set-cookie':'SESSDATA=synthetic-session; Path=/'}}))
  assert.equal((await pending).status,'cancelled')
  assert.equal(f.auth.cookie(),'')
})
test('a refreshed QR cancels the previous session and provider disable cancels all in-flight sessions', async t => {
  const f=await fixture(t), owner={}
  const first=await f.auth.start(owner), second=await f.auth.start(owner)
  assert.equal((await f.auth.poll(owner,first.loginId)).status,'cancelled')
  f.controller.abort()
  assert.equal((await f.auth.poll(owner,second.loginId)).status,'expired')
  assert.equal(f.auth.cookie(),'')
})
test('login persists across providers and local logout overrides an environment fallback across restarts', async t => {
  const f=await fixture(t,{cookie:'SESSDATA=synthetic-environment'}), owner={}
  f.options.code=0; const qr=await f.auth.start(owner)
  await f.auth.poll(owner,qr.loginId)
  const other=await fixture(t,{root:f.root,cookie:'SESSDATA=synthetic-environment'})
  assert.equal((await other.auth.status()).status,'signed-in')
  const oldQr=await other.auth.start({})
  f.auth.logout()
  assert.deepEqual(await other.auth.status(),{status:'signed-out'})
  assert.equal((await other.auth.poll(other.auth.sessions.get(oldQr.loginId).owner,oldQr.loginId)).status,'expired')
  assert.equal(new BilibiliCredentials(f.root,'SESSDATA=synthetic-environment').read().cookie,'')
})
test('expired credentials are reported without exposing the credential and unverified login is never saved', async t => {
  const f=await fixture(t,{cookie:'SESSDATA=synthetic-environment'})
  f.options.login=false
  assert.deepEqual(await f.auth.status(),{status:'expired'})
  f.options.code=0; const owner={}, qr=await f.auth.start(owner)
  await assert.rejects(f.auth.poll(owner,qr.loginId),/有效登录态/)
  assert.equal(f.auth.credentials.read().revision,'initial')
})
test('credential storage rejects symlinks and hard links and reports failed saves', async t => {
  const f=await fixture(t)
  await mkdir(join(f.root,'account'))
  await writeFile(join(f.root,'blocked'),'untouched')
  if (process.platform !== 'win32') {
    await symlink(join(f.root,'blocked'),join(f.root,'account/session.json'))
    assert.throws(()=>f.auth.cookie(),/无法读取/)
    assert.equal(await readFile(join(f.root,'blocked'),'utf8'),'untouched')
    await rm(join(f.root,'account/session.json'))
    await link(join(f.root,'blocked'),join(f.root,'account/session.json'))
    assert.throws(()=>f.auth.cookie(),/无法读取/)
  }
  const other=await fixture(t)
  await writeFile(join(other.root,'account'),'blocked')
  assert.throws(()=>other.auth.logout(),/暂未保存/)
})
test('app-only auth calls require an enabled provider, bind QR ownership and invalidate player grants on logout', async t => {
  const f=await fixture(t), store=new Store(join(f.root,'host'))
  defer(t, ()=>store.close())
  const sources=new ProviderRegistry(f.root,{builtins:[builtins[0],{manifest:builtins[1].manifest,createProvider:()=>f.provider}]})
  const catalog=new Catalog(store,{sources}), service=new Service(store,catalog)
  const a=service.panel(service.open({threadId:'A'}).panel), b=service.panel(service.open({threadId:'B'}).panel)
  await assert.rejects(service.call(a,'start_provider_login',{source:'bilibili'}),/片源插件不可用/)
  await service.call(a,'set_preferences',{enabledProviders:['hongguo','bilibili']})
  const qr=await service.call(a,'start_provider_login',{source:'bilibili'})
  assert.equal((await service.call(b,'poll_provider_login',{source:'bilibili',loginId:qr.loginId})).status,'cancelled')
  f.options.code=0
  assert.equal((await service.call(a,'poll_provider_login',{source:'bilibili',loginId:qr.loginId})).status,'signed-in')
  await service.call(a,'set_source',{source:'bilibili'})
  a.allowed=new Set(['cached-episode']); a.grants=new Set(['cached-episode']); a.streams=new Map([['cached-episode','old']])
  noSecrets(await service.call(a,'get_provider_auth',{source:'bilibili'}))
  await service.call(b,'logout_provider',{source:'bilibili'})
  assert.equal(a.allowed.size,0); assert.equal(a.grants.size,0); assert.equal(a.streams.size,0)
  await assert.rejects(service.call(a,'get_provider_auth',{source:'hongguo'}),/不支持登录/)
})
