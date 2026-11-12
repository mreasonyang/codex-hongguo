import test from 'node:test'
import assert from 'node:assert/strict'
import { HuangguoSource } from '../src/server/sources/huangguo.mjs'

const answer = data => Response.json({ status: 1, data })
function provider(t, request, mediaHeaders = []) {
  const source = new HuangguoSource({ fetch: request, mediaFetcher: headers => {
    mediaHeaders.push(headers)
    return async () => {}
  } })
  t.after(() => source.dispose())
  return source
}

test('host read failures switch mirrors once while the SDK remains unchanged', async t => {
  for (const [method, path, failure, data] of [
    ['search', '/api/search', '获取视频列表失败', { items: [{ id: 'one', title: 'One' }] }],
    ['detail', '/api/videos/one', '获取视频失败', { id: 'one', title: 'One' }],
  ]) {
    const calls = []
    const source = provider(t, async (url, options) => {
      const requested = JSON.parse(options.body).path
      calls.push({ host: new URL(url).hostname, path: requested })
      return calls.length === 1 ? Response.json({ status: 0, msg: failure }) : answer(data)
    })
    if (method === 'search') assert.equal((await source.listSeries({ query: 'fixture', pageSize: 1 })).items[0].id, 'one')
    else assert.equal((await source.getSeries('one')).id, 'one')
    assert.equal(calls.length, 2)
    assert.notEqual(calls[0].host, calls[1].host)
    assert.ok(calls.every(call => call.path.startsWith(path)))
    assert.ok(calls.every(call => !call.path.startsWith('/api/videos?')))
  }
})

test('host business restrictions and ambiguous playback POST failures do not switch mirrors', async t => {
  for (const message of ['获取视频失败，请登录', '会员专享', '观看次数已用完', '请求过于频繁']) {
    let calls = 0
    const source = provider(t, async () => {
      calls++
      return Response.json({ status: 0, msg: message })
    })
    await assert.rejects(source.getSeries('one'), error => error.code === 'CONTENT_UNAVAILABLE')
    assert.equal(calls, 1)
  }
  let posts = 0
  const source = provider(t, async (_url, options) => {
    const envelope = JSON.parse(options.body)
    if (envelope.method === 'POST') { posts++; throw Error('Synthetic lost response') }
    return answer({ id: 'one', title: 'One', episodes: [{ ep_num: 1 }] })
  })
  await assert.rejects(source.resolvePlayback('one:1'), error => error.code === 'NETWORK')
  assert.equal(posts, 1)
})

test('host playback rejects mismatched upstream identity before requesting a stream', async t => {
  const paths = []
  const source = provider(t, async (_url, options) => {
    paths.push(JSON.parse(options.body).path)
    return answer({ id: 'other', title: 'Other', episodes: [{ ep_num: 1 }] })
  })
  await assert.rejects(source.resolvePlayback('one:1'), error => error.code === 'NOT_FOUND')
  assert.deepEqual(paths, ['/api/videos/one'])
})

test('host browsing maps raw rank video_id before passing data to the unchanged SDK', async t => {
  const source = provider(t, async (_url, options) => {
    const path = JSON.parse(options.body).path
    if (path.startsWith('/api/videos?')) return Response.json({ status: 0, msg: '获取视频列表失败' })
    assert.equal(path, '/api/ranks/hot')
    return answer({ items: [{ id: 'rank-row', video_id: 'one', title: 'One', rank: 1 }] })
  })
  assert.equal((await source.listSeries({ pageSize: 2 })).items[0].id, 'one')
})

test('SDK probes and the actual search reuse one real response per host operation', async t => {
  const paths = []
  const source = provider(t, async (_url, options) => {
    paths.push(JSON.parse(options.body).path)
    return answer({ items: [{ id: 'one', title: 'One' }] })
  })
  for (let i = 0; i < 2; i++) assert.equal((await source.listSeries({ query: 'fixture', pageSize: 2 })).items[0].id, 'one')
  assert.deepEqual(paths, ['/api/search?q=fixture&page=1&size=2', '/api/search?q=fixture&page=1&size=2'])
})

test('host hot browsing preserves a transport failure swallowed by the original SDK', async t => {
  const requests = []
  const source = provider(t, async (url, options) => {
    requests.push([new URL(url).hostname, JSON.parse(options.body).path])
    throw Error('Synthetic unavailable mirror')
  })
  await assert.rejects(source.listSeries(), error => error.code === 'NETWORK')
  assert.equal(requests.length, 2)
  assert.equal(new Set(requests.map(row => row[0])).size, 2)
  assert.ok(requests.every(row => row[1] === '/api/ranks/hot'))
})

test('relative media and Referer use the actual successful mirror rather than the SDK probe origin', async t => {
  const mediaHeaders = [], requests = []
  const source = provider(t, async (url, options) => {
    const origin = new URL(url).origin, path = JSON.parse(options.body).path
    requests.push({ origin, path })
    assert.equal(options.headers.get('Origin'), origin)
    assert.equal(options.headers.get('Referer'), origin + '/')
    if (new URL(url).hostname === 'huangguoai.io') throw Error('Synthetic unavailable mirror')
    return answer(path.endsWith('/playback') ? { streams: { main: '/hls/one.m3u8' } }
      : { id: 'one', title: 'One', cover: '/cover.png', episodes: [{ ep_num: 1 }] })
  }, mediaHeaders)
  assert.equal((await source.getSeries('one')).coverURL, 'https://0624.gitiecgad.cc/cover.png')
  const result = await source.resolvePlayback('one:1')
  assert.equal(result.candidates[0].url, 'https://0624.gitiecgad.cc/hls/one.m3u8')
  assert.equal(mediaHeaders.at(-1).Referer, 'https://0624.gitiecgad.cc/video/one/')
  assert.equal(requests.length, 4)
  assert.equal(requests.filter(row => row.path.endsWith('/playback')).length, 1)
})

test('a queued failing request cannot change a completed playback result or its Referer', async t => {
  const mediaHeaders = []
  const source = provider(t, async (url, options) => {
    const path = JSON.parse(options.body).path
    if (path === '/api/videos/two' || (path === '/api/videos/one' && new URL(url).hostname === 'huangguoai.io'))
      throw Error('Synthetic unavailable mirror')
    return answer(path.endsWith('/playback') ? { streams: { main: '/hls/one.m3u8' } }
      : { id: 'one', title: 'One', episodes: [{ ep_num: 1 }] })
  }, mediaHeaders)
  const [playback, unrelated] = await Promise.allSettled([
    source.resolvePlayback('one:1'), source.getSeries('two'),
  ])
  assert.equal(playback.status, 'fulfilled')
  assert.equal(playback.value.candidates[0].url, 'https://0624.gitiecgad.cc/hls/one.m3u8')
  assert.equal(mediaHeaders.at(-1).Referer, 'https://0624.gitiecgad.cc/video/one/')
  assert.equal(unrelated.status, 'rejected')
  assert.equal(unrelated.reason.code, 'NETWORK')
})
