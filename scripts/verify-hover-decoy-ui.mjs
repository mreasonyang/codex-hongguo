// Local UI fixture: production HTML, HTTP transport, Service and SQLite; synthetic media only.
// No provider requests, personal data or plugin installation. Stop with Ctrl-C.
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { Store } from '../src/server/store.mjs'
import { Service } from '../src/server/service.mjs'
import { BrowserServer } from '../src/server/browser.mjs'
import { ensureFfmpeg } from '../src/runtime/ffmpeg-runtime.mjs'

const root = mkdtempSync(join(tmpdir(), 'hongguo-hover-ui-')), store = new Store(root)
const media = join(root, 'fixture.mp4')
execFileSync(await ensureFfmpeg(), ['-nostdin', '-v', 'error', '-stream_loop', '-1', '-i',
  new URL('../test/fixtures/avc-aac.mp4', import.meta.url).pathname, '-t', '120', '-c', 'copy', media], { stdio: 'ignore' })
store.setPreferences({ hoverDecoyEnabled: true, autoplayNext: false, autoPrompt: false })
const catalog = {
  list: async () => ({ items: [] }),
  episodes: async () => ({ items: [{ id: 'hg-101', label: '本地回归视频', number: 1, codec: 'h264', playable: true }] }),
  prepare: () => ({ status: 'ready', src: 'media/hg-101', codec: 'h264', durationMs: 120000 }),
  cache: { path: id => id === 'hg-101' ? media : undefined, hold() {} },
}
const service = new Service(store, catalog), browser = new BrowserServer(service)
const request = browser.request.bind(browser)
browser.request = async (req, res) => {
  const embedded = browser.sessions.get(/^\/p\/([a-f0-9]{24})\//.exec(req.url)?.[1])?.testEmbedded
  if (embedded) {
    const setHeader = res.setHeader.bind(res)
    // This local fixture alone permits its synthetic host to frame the real HTTP player.
    res.setHeader = (name, value) => setHeader(name, name.toLowerCase() === 'content-security-policy'
      ? value.replace("frame-ancestors 'none'", 'frame-ancestors http://127.0.0.1:' + website.address().port) : value)
  }
  if (!['/', '/embedded'].includes(req.url) || req.method !== 'GET' || req.headers.host !== new URL(browser.origin).host)
    return request(req, res)
  // Transfer the synthetic session locally in an HttpOnly cookie, never via printed capabilities.
  const id = randomBytes(12).toString('hex'), key = randomBytes(24).toString('hex'), page = '/p/' + id + '/'
  browser.sessions.set(id, { key, grants: new Set(), expires: Date.now() + 3600000,
    testEmbedded: req.url === '/embedded',
    selection: { seriesId: 'hg-10', episodeId: 'hg-101', title: '本地回归视频' } })
  res.writeHead(302, { 'Set-Cookie': 'hg=' + key + '; Path=' + page + '; HttpOnly; SameSite=Strict',
    Location: page, 'Cache-Control': 'no-store' }).end()
}
const website = createServer((req, res) => {
  if (req.url === '/host') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh-CN"><title>嵌套面板回归</title><style>html,body{margin:0;height:100%;font:15px system-ui;background:#e8ebef}aside{position:fixed;inset:0 60% 0 0;padding:24px;box-sizing:border-box}iframe{position:fixed;left:40%;top:0;width:60%;height:100%;border:0}</style><aside id="chat"><h1>模拟聊天区</h1><p>移动到此处验证面板移出事件</p></aside><iframe id="player" title="播放面板" sandbox="allow-scripts allow-same-origin" src="' + browser.origin + '/embedded"></iframe></html>')
    return
  }
  if (req.url === '/denied') res.setHeader('X-Frame-Options', 'DENY')
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html lang="zh-CN"><title>项目工作台</title><body style="margin:40px;background:#f4f6f8;color:#26313c;font:16px system-ui"><h1>项目工作台</h1><p>自定义替身网页 · 本机测试</p><hr><p>迭代计划</p><p>接口评审</p><p>测试记录</p></body></html>')
})
await new Promise(resolve => website.listen(0, '127.0.0.1', resolve))
await browser.listen()
console.log('Player UI: ' + browser.origin + '/')
console.log('Test cover website: http://127.0.0.1:' + website.address().port + '/')
console.log('Nested panel host: http://127.0.0.1:' + website.address().port + '/host')
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  browser.close(); website.close(); store.close(); rmSync(root, { recursive: true, force: true }); process.exit()
})
