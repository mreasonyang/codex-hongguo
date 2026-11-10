import test from 'node:test'
import assert from 'node:assert/strict'
import { cdn, responseBytes, mediaFetcher, hongguoHosts, allowsHongguoRedirect, allowsHongguoRedirectPort } from '../src/server/sources/network.mjs'

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
  t.mock.method(globalThis, 'fetch', async input => {
    origins.push(new URL(input).origin)
    return origins.length === 1
      ? new Response(null, { status: 302, headers: { location: 'https://fixture.jspcdn.cn:20443/media.mp4' } })
      : new Response(new Uint8Array([1]))
  })
  await cdn('https://fixture.qznovelvod.com/media.mp4', 32, 1000)
  assert.deepEqual(origins, ['https://fixture.qznovelvod.com', 'https://fixture.jspcdn.cn:20443'])
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
