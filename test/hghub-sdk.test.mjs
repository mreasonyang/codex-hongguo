/**
 * 离线测试：只覆盖纯函数（线路规整、封面解密、m3u8 解析、数据整形、线路清单解析）。
 * 联网行为用 `node sdk/hghub/cli.js diag` 之类的命令手工验。
 */

import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv } from 'node:crypto'
const originalNetwork = globalThis.fetch
globalThis.fetch = async () => { throw Error('Network is disabled in offline SDK tests') }
after(() => { globalThis.fetch = originalNetwork })

import {
  normalizeBase,
  coverURL,
  imageKind,
  decryptCover,
  parsePlaylist,
  parseEpisodeId,
  episodeId,
  toCard,
  isMediaHost,
  isImageHost,
  Client,
  HghubError,
  FIXED_LINES,
} from '../src/server/sources/vendor/hghub.mjs'

test('normalizeBase 只接受 http(s) 并把路径砍掉', () => {
  assert.equal(normalizeBase('https://huangguoai.com/'), 'https://huangguoai.com')
  assert.equal(normalizeBase('https://thu.gitiecgad.cc/some/path'), 'https://thu.gitiecgad.cc')
  assert.equal(normalizeBase('  https://huangguoai.ai  '), 'https://huangguoai.ai')
  assert.equal(normalizeBase('ftp://huangguoai.com'), undefined)
  assert.equal(normalizeBase('huangguoai.com'), undefined)
  assert.equal(normalizeBase(''), undefined)
  assert.equal(normalizeBase(undefined), undefined)
})

test('coverURL 拼相对路径、放过绝对地址', () => {
  assert.equal(
    coverURL('/upload_01/upload/20260924/2026092411162272798.jpg'),
    'https://pic.drleao.cn/upload_01/upload/20260924/2026092411162272798.jpg',
  )
  assert.equal(
    coverURL('upload_01/a.jpg'),
    'https://pic.drleao.cn/upload_01/a.jpg',
  )
  assert.equal(coverURL('https://pic.drleao.cn/x.jpg'), 'https://pic.drleao.cn/x.jpg')
  assert.equal(coverURL(''), '')
  assert.equal(coverURL(undefined), '')
})

test('imageKind 认 JPEG / PNG / GIF / WEBP / AVIF', () => {
  assert.equal(imageKind(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg')
  assert.equal(imageKind(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])), 'image/png')
  assert.equal(imageKind(Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(8)])), 'image/gif')
  assert.equal(imageKind(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])), 'image/webp')
  assert.equal(imageKind(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypavif'), Buffer.alloc(4)])), 'image/avif')
  assert.equal(imageKind(Buffer.from([0x09, 0x3d, 0xe3, 0xb1, 0, 0, 0, 0, 0, 0, 0, 0])), '')
  assert.equal(imageKind(Buffer.alloc(4)), '')
  assert.equal(imageKind(Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(4)])), '', 'HEIC 不是浏览器能解的图片')
})

test('decryptCover 解开站点封面（AES-128-CBC），并放过明文', () => {
  // 造一张“站点封面”：JPEG 头 + 若干字节，用站点密钥按 PKCS#7 加密。
  const plain = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 0x41)])
  const cipher = createCipheriv('aes-128-cbc', Buffer.from('f5d965df75336270'), Buffer.from('97b60394abc2fbe1'))
  const encrypted = Buffer.concat([cipher.update(plain), cipher.final()])
  assert.equal(encrypted.length % 16, 0)
  assert.ok(encrypted.length > plain.length, '密文含补齐')

  assert.equal(imageKind(encrypted), '', '密文不应认成图片')
  const decoded = decryptCover(encrypted)
  assert.equal(imageKind(decoded), 'image/jpeg')
  assert.deepEqual(decoded, plain, '补齐字节应被去掉')

  // 明文原样返回。
  assert.deepEqual(decryptCover(plain), plain)
})

test('decryptCover 对坏密文抛 COVER_BAD_CIPHER', () => {
  assert.throws(() => decryptCover(Buffer.alloc(17)), (error) => {
    assert.ok(error instanceof HghubError)
    assert.equal(error.code, 'COVER_BAD_CIPHER')
    return true
  })
})

test('decryptCover 对解不出图片的密文抛 COVER_BAD_PLAIN', () => {
  const junk = Buffer.alloc(32, 0)
  assert.throws(() => decryptCover(junk), (error) => error.code === 'COVER_BAD_PLAIN')
})

test('parsePlaylist 抽出 key / IV / 分片，相对路径按列表基址解析', () => {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-KEY:METHOD=AES-128,URI="https://tp4.drleao.cn/videos5/abc/crypt.key?auth_key=1",IV=0x9ADBB8A155543880CDADBD13F4BC1A22',
    '#EXT-X-TARGETDURATION:6',
    '#EXTINF:5.200,',
    'https://tp4.drleao.cn/videos5/abc/abc0.ts?auth_key=2',
    '#EXTINF:4.800,',
    'abc1.ts',
    '',
  ].join('\n')

  const parsed = parsePlaylist(manifest, 'https://yd-lphu-hls.hzjvlo.cn/videos5/abc/abc.m3u8')
  assert.equal(parsed.method, 'AES-128')
  assert.equal(parsed.keyURL, 'https://tp4.drleao.cn/videos5/abc/crypt.key?auth_key=1')
  assert.equal(parsed.iv, '9adbb8a155543880cdadbd13f4bc1a22')
  assert.deepEqual(parsed.segments, [
    'https://tp4.drleao.cn/videos5/abc/abc0.ts?auth_key=2',
    'https://yd-lphu-hls.hzjvlo.cn/videos5/abc/abc1.ts',
  ])
})

test('parsePlaylist 对没有 key 的列表不报错', () => {
  const parsed = parsePlaylist('#EXTM3U\n#EXTINF:4,\nseg0.ts\n', 'https://x.test/v/a.m3u8')
  assert.equal(parsed.keyURL, null)
  assert.equal(parsed.method, null)
  assert.deepEqual(parsed.segments, ['https://x.test/v/seg0.ts'])
  assert.deepEqual(parsed.variants, [])
  assert.deepEqual(parsePlaylist('', 'https://x.test/a.m3u8').segments, [])
})

test('parsePlaylist 把主列表的子播放列表放进 variants，不当成分片', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=720x1280',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1080x1920',
    'https://cdn.test/high/index.m3u8',
  ].join('\n')

  const parsed = parsePlaylist(master, 'https://cdn.test/v/a.m3u8')
  assert.deepEqual(parsed.segments, [], '主列表里没有分片')
  assert.deepEqual(parsed.variants, [
    'https://cdn.test/v/low/index.m3u8',
    'https://cdn.test/high/index.m3u8',
  ])
})

test('集 id 的拼装与拆解', () => {
  assert.equal(episodeId(117, 3), '117_3')
  assert.deepEqual(parseEpisodeId('117_3'), { videoId: '117', ep: 3 })
  assert.deepEqual(parseEpisodeId('abc-1_12'), { videoId: 'abc-1', ep: 12 })
  assert.equal(parseEpisodeId('117'), undefined)
  assert.equal(parseEpisodeId('117_x'), undefined)
  assert.equal(parseEpisodeId(undefined), undefined)
})

test('toCard 统一列表行，缺字段用默认值', () => {
  const card = toCard({
    id: 12,
    title: '神瞳觉醒 第一季',
    desc: '简介',
    cover: '/upload_01/a.jpg',
    tags: ['超能力', '都市'],
    score: 9.6,
    episode_count: 21,
    hot: 61969179,
    is_finished: true,
    cate_id: '24',
  })
  assert.equal(card.id, 12)
  assert.equal(card.title, '神瞳觉醒 第一季')
  assert.equal(card.description, '简介')
  assert.equal(card.cover, 'https://pic.drleao.cn/upload_01/a.jpg')
  assert.equal(card.episodes, 21)
  assert.equal(card.finished, true)
  assert.equal(card.categoryId, '24')

  const bare = toCard({ id: 1, title: 'T' })
  assert.equal(bare.description, '')
  assert.deepEqual(bare.tags, [])
  assert.equal(bare.cover, '')
  assert.equal(bare.episodes, 0)
  assert.equal(bare.finished, false)
})

test('主机白名单只放播放/图片链路', () => {
  assert.equal(isMediaHost('tp4.drleao.cn'), true)
  assert.equal(isMediaHost('yd-lphu-hls.hzjvlo.cn'), true)
  assert.equal(isMediaHost('drleao.cn'), true)
  assert.equal(isMediaHost('evil-drleao.cn'), false, '不能靠后缀前缀混过去')
  assert.equal(isMediaHost('evil.com'), false)
  assert.equal(isMediaHost(undefined), false)

  assert.equal(isImageHost('pic.drleao.cn'), true)
  assert.equal(isImageHost('huangguoai.com'), true)
  assert.equal(isImageHost('tracker.example.com'), false)
})

test('setBase 拒绝无效线路，接受并规整有效线路', () => {
  const client = new Client({ store: { load: async () => null, save: async () => {}, reset: async () => {} } })
  assert.equal(client.base, FIXED_LINES[0].url)
  assert.equal(client.setBase('https://thu.gitiecgad.cc/'), 'https://thu.gitiecgad.cc')
  assert.equal(client.base, 'https://thu.gitiecgad.cc')
  assert.throws(() => client.setBase('not a url'), (error) => error.code === 'BAD_LINE')
  assert.equal(client.base, 'https://thu.gitiecgad.cc', '失败的切换不应改动线路')
})

test('request 拼查询串时跳过空值', async () => {
  const client = new Client({ store: { load: async () => null, save: async () => {}, reset: async () => {} } })
  let seen
  client._waitTurn = async () => {}
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen = { url, headers: init.headers, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({ status: 1, data: { ok: true } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    await client.request('/api/videos/117/play', { query: { ep: 3, page_texts: 0, skip: '', drop: null } })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(seen.url, 'https://huangguoai.com/api/edge/request')
  assert.equal(seen.body.method, 'GET')
  assert.equal(seen.body.path, '/api/videos/117/play?ep=3&page_texts=0')
  assert.equal(seen.body.body, '', 'GET 没有请求体')
  assert.equal(seen.body.content_type, '')
  assert.equal(seen.headers.authorization, undefined, '匿名请求不带 token')
})

test('request 把 POST 体转成 base64 并带上 token', async () => {
  const client = new Client({ store: { load: async () => null, save: async () => {}, reset: async () => {} } })
  client.token = 'tok-1'
  client._profileLoaded = true
  client._waitTurn = async () => {}
  let seen
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen = { headers: init.headers, body: JSON.parse(init.body) }
    return new Response(JSON.stringify({ status: 1, data: { token: 'new' } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  try {
    await client.request('/api/account/loginByPassword', { method: 'POST', body: { username: 'u', password: 'p' }, auth: false })
  } finally {
    globalThis.fetch = originalFetch
  }

  assert.equal(seen.body.method, 'POST')
  assert.equal(seen.body.content_type, 'application/json')
  assert.deepEqual(JSON.parse(Buffer.from(seen.body.body, 'base64').toString('utf8')), { username: 'u', password: 'p' })
  assert.equal(seen.headers.authorization, undefined, 'auth:false 不带 token')
})

test('request 把 status:0 的响应变成 HghubError', async () => {
  const client = new Client({ store: { load: async () => null, save: async () => {}, reset: async () => {} } })
  client._waitTurn = async () => {}
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ status: 0, msg: '视频不存在', data: [] }), { status: 200 })
  try {
    await assert.rejects(client.request('/api/videos/999999'), (error) => {
      assert.equal(error.code, 'API_ERROR')
      assert.equal(error.message, '视频不存在')
      return true
    })
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('request 在网络错误时重试，用尽后抛 NETWORK', async () => {
  const client = new Client({ store: { load: async () => null, save: async () => {}, reset: async () => {} }, retries: 2 })
  client._waitTurn = async () => {}
  let attempts = 0
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    attempts += 1
    throw new Error('fetch failed')
  }
  try {
    await assert.rejects(client.request('/api/home'), (error) => error.code === 'NETWORK')
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(attempts, 3, '一次原始请求 + 两次重试')
})

test('未登录时只读接口照样可用（不触发登录）', async () => {
  const client = await (async () => {
    const instance = new Client({ store: { load: async () => null, save: async () => {}, reset: async () => {} } })
    await instance.loadProfile()
    return instance
  })()
  assert.equal(client.isLoggedIn, false)
})
