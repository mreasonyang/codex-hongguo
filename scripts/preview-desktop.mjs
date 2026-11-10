// Exercise the shipped MCP App in a sandbox, with its real service and native renderer.
// All state is disposable. No installed plugin, user account or hook is modified.
import { createServer } from 'node:http'
import { mkdtemp, readFile, cp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { randomBytes } from 'node:crypto'
import { Readable, PassThrough } from 'node:stream'
import { Store } from '../src/server/store.mjs'
import { Catalog } from '../src/server/catalog.mjs'
import { Service } from '../src/server/service.mjs'
import { DetachedPlayers } from '../src/server/detached.mjs'
import { MediaCache, runFfmpeg } from '../src/server/media.mjs'
import { ProviderRegistry, builtins } from '../src/server/providers/registry.mjs'

const live=process.argv.includes('--live'),root=await mkdtemp(join(tmpdir(),'desktop-qualification-'))
const store=new Store(root),session='desktop-qualification'
store.setPreferences({defaultMuted:true})
const fixture={manifest:builtins[0].manifest,createProvider:()=>({id:'hongguo',discovery:false,
  async listSeries(){return {items:[{id:'1',title:'桌面播放器验证',episodes:2}],cursor:null}},
  async getSeries(){return {id:'1',title:'桌面播放器验证',episodes:2}},
  async listEpisodes(){return {items:[{id:'11',number:1,label:'第 1 集'},{id:'12',number:2,label:'第 2 集'}],cursor:null}},
  async getCover(){return null},async resolvePlayback(){throw Error('Fixture cache only')},
})}
const sources=new ProviderRegistry(root,{builtins:live?builtins:[fixture]});await sources.ready
const catalog=new Catalog(store,{sources});await catalog.prepareMediaRuntime()
if(!live){
  const file=join(root,'fixture.mp4')
  await runFfmpeg(['-f','lavfi','-i','testsrc2=size=640x360:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000',
    '-t','90','-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-g','48','-c:a','aac','-movflags','+faststart','-y',file])
  catalog.cache=new MediaCache(store,()=>{throw Error('Fixture cache only')})
  for(const id of ['hg-11','hg-12']){
    await cp(file,catalog.cache.path(id));store.db.prepare("INSERT INTO media(id,status,accessed,size,codec,revision) VALUES(?,'ready',?,?,?,?)").run(id,Date.now(),(await stat(file)).size,'avc1.42c01e,mp4a.40.2','')
  }
  if(process.argv.includes('--dash')){
    const tracks=[]
    for(const [i,type] of ['v','a'].entries()){
      const path=join(root,'track-'+i+'.mp4')
      await runFfmpeg(['-i',file,'-map','0:'+type+':0','-c','copy','-frag_duration','2000000',
        '-movflags','+dash+global_sidx+frag_keyframe+empty_moov+default_base_moof',path])
      const bytes=await readFile(path);let offset=0
      while(bytes.toString('ascii',offset+4,offset+8)!=='sidx')offset+=bytes.readUInt32BE(offset)
      const length=bytes.readUInt32BE(offset)
      tracks.push({bytes,url:String(i),initialization:'0-'+(offset-1),indexRange:offset+'-'+(offset+length-1),
        mime:i?'audio/mp4; codecs="mp4a.40.2"':'video/mp4; codecs="avc1.42c01e"'})
    }
    const provider=sources.get('hongguo');provider.progressivePlayback=true
    provider.resolvePlayback=async()=>({durationMs:90000,candidates:[{kind:'tracks',video:tracks[0],audio:tracks[1]}],
      fetchMedia:async(name,_budget,_timeout,_redirects,range)=>({body:Readable.from([tracks[Number(name)].bytes.subarray(range.offset,range.offset+range.length)]),limit:new PassThrough()})})
  }
}
const service=new Service(store,catalog);service.detached=new DetachedPlayers(service)
const events=[],handleEvent=service.detached.event.bind(service.detached)
service.detached.event=async input=>{
  if(input.type!=='progress'){events.push({at:Date.now(),type:input.type,command:input.command,generation:input.generation,point:input.point,escaped:input.escaped,canceled:input.canceled});if(events.length>100)events.shift()}
  return handleEvent(input)
}
const receiptTimer=setInterval(()=>void writeFile(join(root,'evidence.json'),JSON.stringify({events,
  players:[...service.detached.players.values()].map(p=>({...service.detached.view(p),viewport:p.viewport,point:p.point})),history:store.history()},null,2)),1000)
receiptTimer.unref()
const initial=service.open({threadId:session}),scope=service.panel(initial.panel)
const credential=randomBytes(24).toString('base64url')
const bundle=await build({stdin:{contents:`import {AppBridge,PostMessageTransport} from '@modelcontextprotocol/ext-apps/app-bridge';
const frame=document.querySelector('iframe');
const bridge=new AppBridge(null,{name:'Desktop qualification',version:'1'},{serverTools:{},logging:{}},{hostContext:{theme:'dark',locale:'zh-CN',displayMode:'fullscreen',availableDisplayModes:['inline','fullscreen']}});
bridge.oncalltool=async params=>(await fetch('/tool',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(params)})).json();
bridge.oninitialized=async()=>{await bridge.sendToolInput({arguments:{}});await bridge.sendToolResult(await(await fetch('/initial')).json());};
bridge.onsizechange=()=>{};bridge.onrequestdisplaymode=()=>({mode:'fullscreen'});
await bridge.connect(new PostMessageTransport(frame.contentWindow,frame.contentWindow));frame.src='/player';`,resolveDir:process.cwd()},bundle:true,write:false,platform:'browser',format:'esm'})
let origin
const server=createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer')
  if(req.headers.host!==new URL(origin).host){res.writeHead(403);res.end();return}
  if(req.url==='/'){
    res.setHeader('Set-Cookie','qualification='+credential+'; HttpOnly; SameSite=Strict; Path=/')
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><meta charset="utf-8"><title>红果桌面播放器验证</title><style>body{margin:0;background:#17191f;color:#b6bcc8;font:14px system-ui}header{padding:14px}iframe{border:0;position:absolute;left:0;top:48px;width:460px;height:calc(100vh - 48px)}aside{position:absolute;left:490px;top:65px}</style><header>本地候选 · 真实 MCP App 沙箱</header><aside>将播放器标题拖出左侧面板，或点击「移到桌面」。<br>独立窗口的标题可拖回左侧空位。</aside><iframe sandbox="allow-scripts" allow="autoplay"></iframe><script type="module" src="/host.js"></script>');return
  }
  if(!req.headers.cookie?.split('; ').includes('qualification='+credential) && req.url!=='/player'){res.writeHead(403);res.end();return}
  try{
    if(req.url==='/host.js'){res.setHeader('Content-Type','text/javascript');res.end(bundle.outputFiles[0].text)}
    else if(req.url==='/player'){res.setHeader('Content-Type','text/html');res.end(await readFile('dist/ui/player.html'))}
    else if(req.url==='/initial'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({content:[],structuredContent:{identified:true,source:'hongguo'},_meta:{panel:initial.panel}}))}
    else if(req.url==='/tool'&&req.method==='POST'&&req.headers.origin===origin){
      let body='';for await(const part of req){body+=part;if(body.length>16384)throw Error('size')}
      const {name,arguments:args}=JSON.parse(body)
      let result
      if(name==='open_drama_panel')result={content:[],structuredContent:{identified:true,source:'hongguo'},_meta:{panel:initial.panel}}
      else{const {panel,...input}=args??{};if(panel!==initial.panel)throw Error('panel');result={content:[],_meta:{data:await service.call(scope,name,input)}}}
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify(result))
    }else if(req.url==='/qualification/state'){
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({players:[...service.detached.players.values()].map(p=>service.detached.view(p)),history:store.history(),nativeSupported:service.detached.supported}))
    }else if(req.url==='/qualification/stop'&&req.method==='POST'&&req.headers.origin===origin){
      store.event({session_id:session,turn_id:'qualification-turn',hook_event_name:'Stop'});res.end('{}')
    }else{res.writeHead(404);res.end()}
  }catch{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({isError:true,content:[{type:'text',text:'验证调用失败'}]}))}
})
await new Promise(ok=>server.listen(0,'127.0.0.1',ok));origin='http://127.0.0.1:'+server.address().port
store.event({session_id:session,turn_id:'qualification-turn',hook_event_name:'UserPromptSubmit'})
console.log(JSON.stringify({origin,mode:live?'anonymous-live':'synthetic-local',root}))
async function close(){clearInterval(receiptTimer);service.detached.close();server.closeAllConnections();server.close();await sources.dispose();store.close();process.exit()}
process.once('SIGINT',close);process.once('SIGTERM',close)
