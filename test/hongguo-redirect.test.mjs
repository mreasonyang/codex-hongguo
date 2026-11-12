import test from 'node:test'
import assert from 'node:assert/strict'
import { cdn, responseBytes, mediaFetcher, hongguoHosts, allowsHongguoRedirect, allowsHongguoRedirectPort } from '../src/server/sources/network.mjs'
import { ProviderRegistry } from '../src/server/providers/registry.mjs'

test('Hongguo CDN accepts its routing redirect after a valid media origin', async t => {
  const hosts = []
  t.mock.method(globalThis, 'fetch', async input => {
    hosts.push(new URL(input).hostname)
    return hosts.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://fixture.bdcgslb.com/media.mp4' } })
      : new Response(new Uint8Array([1, 2, 3]))
  })
  const result = await cdn('https://fixture.qznovelvod.com/media.mp4', 32, 1000)
  assert.deepEqual(await responseBytes(result.body, 32), Buffer.from([1, 2, 3]))
  assert.deepEqual(hosts, ['fixture.qznovelvod.com', 'fixture.bdcgslb.com'])
})

test('Hongguo CDN rejects direct routing-domain locators before a request', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw Error('Unexpected network request') })
  await assert.rejects(cdn('https://fixture.bdcgslb.com/media.mp4', 32, 1000))
  assert.equal(calls, 0)
})

test('Hongguo CDN rejects redirects outside the media and routing domains', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response(null, { status: 302, headers: { location: 'https://fixture.invalid/media.mp4' } })
  })
  await assert.rejects(cdn('https://fixture.qznovelvod.com/media.mp4', 32, 1000))
  assert.equal(calls, 1)
})

test('Hongguo CDN accepts only the observed routing port after an allowed origin', async t => {
  const origins = []
  t.mock.method(globalThis, 'fetch', async (input, options) => {
    origins.push(new URL(input).origin)
    assert.equal(new Headers(options.headers).get('range'), 'bytes=8-8')
    return origins.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://fixture.jspcdn.cn:20443/media.mp4' } })
      : new Response(new Uint8Array([1]), { status: 206, headers: { 'content-range': 'bytes 8-8/128' } })
  })
  const result = await cdn('https://fixture.qznovelvod.com/media.mp4', 1, 1000, 0, { offset: 8, length: 1 })
  assert.equal(result.totalBytes, 128)
  assert.deepEqual(await responseBytes(result.body, 1), Buffer.from([1]))
  assert.deepEqual(origins, ['https://fixture.qznovelvod.com', 'https://fixture.jspcdn.cn:20443'])
})

test('provider request options cannot grant extra redirect domains or ports', async t => {
  const registry = new ProviderRegistry('/unused', { builtins: [], directory: '' })
  t.after(() => registry.dispose())
  const context = registry.context({ id: 'fixture', network: { api: ['fixture.invalid'] } })
  const input = 'https://fixture.invalid/api'
  let destination = 'https://other.invalid/route'
  const calls = []
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url.href)
    return url.href === input
      ? new Response(null, { status: 302, headers: { location: destination } })
      : new Response('unexpected')
  })
  const options = { redirectAllows: () => true, redirectPorts: () => true }
  await assert.rejects(context.fetch(input, options), { code: 'HOST_NOT_ALLOWED' })
  destination = 'https://fixture.invalid:20443/route'
  await assert.rejects(context.fetch(input, options), /域名/)
  assert.deepEqual(calls, [input, input])
})

test('Hongguo CDN rejects direct routing URLs and unrelated nonstandard ports', async t => {
  let calls = 0
  let destination = 'https://fixture.jspcdn.cn:8443/media.mp4'
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response(null, { status: 302, headers: { location: destination } })
  })
  await assert.rejects(cdn('https://fixture.jspcdn.cn:20443/media.mp4', 32, 1000))
  assert.equal(calls, 0)
  await assert.rejects(cdn('https://fixture.qznovelvod.com/media.mp4', 32, 1000))
  assert.equal(calls, 1)
  destination = 'https://fixture.bdcgslb.com:20443/media.mp4'
  await assert.rejects(cdn('https://fixture.qznovelvod.com/media.mp4', 32, 1000))
  assert.equal(calls, 2)
})

test('routing exceptions never forward an authenticated request to another origin', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response(null, { status: 302, headers: { location: 'https://fixture.jspcdn.cn:20443/media.mp4' } })
  })
  const fetcher = mediaFetcher({ allows: host => hongguoHosts.test(host),
    redirectAllows: allowsHongguoRedirect, redirectPorts: allowsHongguoRedirectPort,
    headers: { Cookie: 'fixture=synthetic' } })
  await assert.rejects(fetcher('https://fixture.qznovelvod.com/media.mp4', 32, 1000))
  assert.equal(calls, 1)
})
