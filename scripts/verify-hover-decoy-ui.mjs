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
let rejectSettings = false
const observations = []
const call = service.call.bind(service)
service.call = (...args) => {
  if (args[1] === 'set_preferences' && rejectSettings) return Promise.reject(Error('Synthetic save failure'))
  return call(...args)
}
const request = browser.request.bind(browser)
browser.request = async (req, res) => {
  if (req.headers.host === new URL(browser.origin).host && req.url === '/validation-events' && req.method === 'POST') {
    let data = ''
    for await (const chunk of req) { data += chunk; if (data.length > 1024) { res.writeHead(413).end(); return } }
    try {
      const row = JSON.parse(data)
      if (typeof row.type === 'string' && typeof row.covered === 'boolean') observations.push(row)
      if (observations.length > 2000) observations.shift()
    } catch { /* Ignore invalid fixture-only observations. */ }
    res.writeHead(204).end(); return
  }
  if (req.headers.host === new URL(browser.origin).host && req.url === '/validation-events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(observations)); return
  }
  if (req.headers.host === new URL(browser.origin).host && req.url === '/validation-reset' && req.method === 'POST') {
    observations.length = 0; res.writeHead(204).end(); return
  }
  const embedded = browser.sessions.get(/^\/p\/([a-f0-9]{24})\//.exec(req.url)?.[1])?.testEmbedded
  if (embedded) {
    const setHeader = res.setHeader.bind(res)
    // This local fixture alone permits its synthetic host to frame the real HTTP player.
    res.setHeader = (name, value) => setHeader(name, name.toLowerCase() === 'content-security-policy'
      ? value.replace("frame-ancestors 'none'", 'frame-ancestors http://127.0.0.1:' + website.address().port) : value)
    const end = res.end.bind(res)
    res.end = (value, ...args) => {
      if (typeof value === 'string' && value.includes('id="playerRoot"')) {
        const nonce = /<script nonce="([^"]+)"/.exec(value)?.[1]
        if (nonce) value = value.replace('</body>', `<script nonce="${nonce}">
          (() => {
            const root = document.documentElement, settings = document.getElementById('settings');
            const combo = document.getElementById('coverStyle');
            function record(type, event) {
              fetch('/validation-events', { method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({type, covered:root.dataset.decoyCovered==='true',
                  settingsOpen:!settings.hidden, menuOpen:combo.getAttribute('aria-expanded')==='true',
                  style:combo.dataset.value||'', at:performance.now(),
                  x:event?.clientX,y:event?.clientY,width:innerWidth,height:innerHeight}) }).catch(()=>{});
            }
            let previous = root.dataset.decoyCovered;
            new MutationObserver(()=>{if(previous!==root.dataset.decoyCovered){previous=root.dataset.decoyCovered;record('cover');}})
              .observe(root,{attributes:true,attributeFilter:['data-decoy-covered']});
            for(const type of ['click','keydown']) document.addEventListener(type,()=>record(type));
            for(const type of ['pointerout','mouseout','mouseleave']) document.addEventListener(type,event=>{
              if(!event.relatedTarget)record(type,event);
            },true);
            root.addEventListener('pointerleave',event=>record('root-leave',event));
            window.addEventListener('blur',()=>record('blur'));
            record('ready');
          })();
        </script></body>`)
      }
      return end(value, ...args)
    }
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
  // Local-only test controls. Never included in the packaged player.
  if (req.method === 'POST' && ['/fail-settings', '/restore-settings'].includes(req.url)) {
    rejectSettings = req.url === '/fail-settings'
    res.writeHead(204).end(); return
  }
  if (req.url === '/settings-test') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh-CN"><title>设置故障测试</title><button id="fail" onclick="fetch(\'/fail-settings\',{method:\'POST\'}).then(()=>document.getElementById(\'status\').textContent=\'保存失败已启用\')">模拟保存失败</button><button id="restore" onclick="fetch(\'/restore-settings\',{method:\'POST\'}).then(()=>document.getElementById(\'status\').textContent=\'保存已恢复\')">恢复保存</button><p id="status"></p></html>')
    return
  }
  if (req.url === '/host') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<!doctype html><html lang="zh-CN"><title>嵌套面板回归</title><style>html,body{margin:0;height:100%;font:15px system-ui;background:#e8ebef}aside{position:fixed;inset:0 60% 0 0;padding:24px;box-sizing:border-box}iframe{position:fixed;left:40%;top:0;width:60%;height:100%;border:0}</style><aside id="chat"><h1>模拟聊天区</h1><p>移动到此处验证面板移出事件</p></aside><iframe id="player" title="播放面板" sandbox="allow-scripts allow-same-origin" src="' + browser.origin + '/embedded"></iframe></html>')
    return
  }
  res.writeHead(404).end()
})
await new Promise(resolve => website.listen(0, '127.0.0.1', resolve))
await browser.listen()
console.log('Player UI: ' + browser.origin + '/')
console.log('Nested panel host: http://127.0.0.1:' + website.address().port + '/host')
console.log('Settings test controls: http://127.0.0.1:' + website.address().port + '/settings-test')
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  browser.close(); website.close(); store.close(); rmSync(root, { recursive: true, force: true }); process.exit()
})
