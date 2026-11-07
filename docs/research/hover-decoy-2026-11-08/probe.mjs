// Disposable browser experiment, independent of the Hongguo application and user data.
// Run from any directory: node docs/research/hover-decoy-2026-11-08/probe.mjs
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'

const fixture = readFileSync(new URL('../../../test/fixtures/avc-aac.mp4', import.meta.url))
const html = (res, body, csp) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    ...(csp ? { 'Content-Security-Policy': csp } : {}) })
  res.end(body)
}
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1')
  if (url.pathname === '/fixture.mp4') {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': fixture.length })
    res.end(fixture)
    return
  }
  if (url.pathname === '/decoy') {
    if (url.searchParams.has('deny')) res.setHeader('X-Frame-Options', 'DENY')
    return html(res, '<!doctype html><html lang="zh-CN"><title>替身测试网页</title><body style="background:#f5f5f2;padding:24px;font:16px system-ui"><h1>项目工作台</h1><p>外部网页嵌入探针（合成页面）</p></body></html>')
  }
  if (url.pathname === '/') return html(res, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>悬停替身可行性探针</title>
  <style>body{margin:0;padding:24px;background:#e8ebee;color:#20252a;font:15px system-ui}main{display:flex;gap:24px}aside{width:340px}iframe{width:440px;height:600px;border:1px solid #abb4bd;border-radius:8px}pre{white-space:pre-wrap;font:13px monospace}button{margin:3px;padding:10px}small{color:#59636d}</style>
  <h1>悬停替身可行性探针</h1><small>独立合成实验，不代表 Codex 插件面板验收</small>
  <main><aside id="chat"><h2>模拟聊天区</h2><p>将鼠标移到这里应立即遮盖并暂停右侧面板。</p>
  <button data-mode="builtin">内置替身</button><button data-mode="allowed">允许嵌入</button><button data-mode="denied">网站拒绝嵌入</button><button data-mode="csp">宿主拒绝嵌入</button>
  <h3>实验状态</h3><pre id="state">等待面板</pre></aside><iframe id="panel" title="模拟红果播放面板" sandbox="allow-scripts" src="/panel?mode=builtin"></iframe></main>
  <script>const panel=document.querySelector('#panel'); document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>panel.src='/panel?mode='+b.dataset.mode);
  addEventListener('message',e=>{if(e.source===panel.contentWindow&&e.data?.probe==='hover-decoy')document.querySelector('#state').textContent=JSON.stringify(e.data.state,null,2)});</script></html>`)
  if (url.pathname === '/panel') {
    const mode = ['builtin', 'allowed', 'denied', 'csp'].includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'builtin'
    return html(res, `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>模拟播放面板</title>
    <style>*{box-sizing:border-box}html,body{height:100%;margin:0;font:15px system-ui}body{background:#fcfcfa}.player{padding:22px}.player h2{font-size:20px}video{width:100%;height:260px;background:#17191b}button{padding:10px;margin:6px 0}.decoy{position:fixed;inset:0;background:#fcfcfa;z-index:10;padding:28px}.decoy h2{font-size:24px}.decoy p{border-bottom:1px solid #ddd;padding:12px 0}.decoy iframe{position:absolute;inset:0;width:100%;height:100%;border:0;pointer-events:none}.decoy{display:none}body[data-covered="true"] .decoy{display:block}body[data-covered="true"] .player{visibility:hidden}</style>
    <body data-covered="true"><div id="root" style="position:fixed;inset:0"><section class="player"><h2>短剧播放器（本地测试片）</h2><video muted playsinline loop preload="auto" src="/fixture.mp4"></video><p><button id="play">播放 / 手动暂停</button></p><button id="stop">模拟任务结束</button><p id="position"></p></section>
    <section class="decoy"><h2>工作笔记</h2><p>本周计划与待办</p><p>整理接口文档</p><p>核对测试结果</p><p>准备迭代评审</p>
    ${mode === 'builtin' ? '' : '<iframe title="替身网页" sandbox="" referrerpolicy="no-referrer" src="/decoy' + (mode === 'denied' ? '?deny=1' : '') + '"></iframe>'}</section></div>
    <script>
    const video=document.querySelector('video'), player=document.querySelector('.player');
    let inside=false, resume=false, generation=0, enterTimer, starts=0, lastEvent='initial', lastError=null, frameLoads=0, frameErrors=0;
    function report(){document.querySelector('#position').textContent='进度 '+video.currentTime.toFixed(3)+' s';parent.postMessage({probe:'hover-decoy',state:{mode:${JSON.stringify(mode)},covered:document.body.dataset.covered==='true',paused:video.paused,position:Number(video.currentTime.toFixed(3)),sameVideo:video===document.querySelector('video'),starts,lastEvent,lastError,frameLoads,frameErrors}},'*')}
    function hide(reason){inside=false;clearTimeout(enterTimer);resume=resume||!video.paused;generation++;document.body.dataset.covered='true';player.inert=true;video.pause();lastEvent=reason;report()}
    async function start(reason){const ticket=++generation;try{await video.play();if(ticket!==generation||!inside){video.pause();return}starts++;lastEvent=reason;lastError=null}catch(e){lastError=e.name}report()}
    function enter(){if(inside)return;inside=true;const ticket=generation;enterTimer=setTimeout(()=>{if(!inside||ticket!==generation)return;document.body.dataset.covered='false';player.inert=false;lastEvent='pointerenter';if(resume){resume=false;void start('hover-resume')}report()},150)}
    document.querySelector('#root').addEventListener('pointerenter',enter);
    document.querySelector('#root').addEventListener('pointermove',enter);
    document.querySelector('#root').addEventListener('pointerleave',()=>hide('pointerleave'));
    document.addEventListener('pointerout',e=>{if(e.relatedTarget===null)hide('pointerout')});
    document.addEventListener('mouseout',e=>{if(e.relatedTarget===null)hide('mouseout')});
    addEventListener('blur',()=>hide('blur'));
    document.addEventListener('visibilitychange',()=>{if(document.hidden)hide('hidden')});
    document.querySelector('#play').onclick=()=>{resume=false;if(video.paused)void start('manual-play');else{generation++;video.pause();lastEvent='manual-pause';report()}};
    document.querySelector('#stop').onclick=()=>{resume=false;generation++;video.pause();lastEvent='turn-stop';report()};
    const frame=document.querySelector('.decoy iframe');if(frame){frame.onload=()=>{frameLoads++;report()};frame.onerror=()=>{frameErrors++;report()}}
    setInterval(report,200);report();
    </script></body></html>`, `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; media-src http://127.0.0.1:${server.address().port}; frame-src ${mode === 'allowed' || mode === 'denied' ? 'http://127.0.0.1:' + server.address().port : "'none'"}`)
  }
  res.writeHead(404).end()
})
server.listen(0, '127.0.0.1', () => console.log('Probe URL: http://127.0.0.1:' + server.address().port + '/'))
for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => server.close(() => process.exit()))
