import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { release } from 'node:os'
import { z } from 'zod'
import { projectRoot } from './paths.mjs'
import { PlayerError, message } from './errors.mjs'
import { matchesSeries, seriesPattern, episodePattern, parseId } from './sources/ids.mjs'
import { serveNativeMedia } from './native-media.mjs'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/)
const ms = z.number().int().min(0).max(86400000)
const point = z.object({ x:z.number().finite().min(-100000).max(100000), y:z.number().finite().min(-100000).max(100000) })
const viewport = z.object({ x:z.number().finite(), y:z.number().finite(), width:z.number().positive().max(20000), height:z.number().positive().max(20000), visible:z.boolean() })
export const windowSnapshot = z.object({
  seriesId:z.string().regex(seriesPattern), episodeId:z.string().regex(episodePattern),
  title:z.string().min(1).max(320), label:z.string().min(1).max(320),
  positionMs:ms, durationMs:ms.positive(), paused:z.boolean(), muted:z.boolean(),
  volume:z.number().min(0).max(1), rate:z.number().min(0.25).max(4),
})
export const desktopSchemas = {
  get_window_state:z.object({ instance:id, warm:z.boolean().optional(), viewport:viewport.optional(), locale:z.string().max(40).optional() }),
  prepare_desktop_player:z.object({ instance:id, episodeId:z.string().regex(episodePattern) }),
  detach_player:z.object({ instance:id, snapshot:windowSnapshot, point:point.optional(), dragging:z.boolean().optional() }),
  finish_player_drag:z.object({ instance:id, generation:ms, cancel:z.boolean().optional(), point:point.optional() }),
  dock_player:z.object({ instance:id, generation:ms, playerId:id.optional() }),
  confirm_player_docked:z.object({ instance:id, generation:ms }),
}
const blockedCommands = new Set(['prepare_playback','save_progress','set_source','set_content_preferences','select_waiting_pick'])
const nativeEvent = z.object({ playerId:id, generation:ms, type:z.enum(['ready','progress','frozen','error','command','drag-end']),
  control:ms.optional(),
  positionMs:ms.optional(), durationMs:ms.optional(), paused:z.boolean().optional(), muted:z.boolean().optional(),
  volume:z.number().min(0).max(1).optional(), rate:z.number().min(0.25).max(4).optional(),
  command:z.enum(['toggle','mute','seek','rate','volume','next','previous','dock','ended','hover-enter','hover-leave']).optional(),
  point:point.optional(), canceled:z.boolean().optional(), escaped:z.boolean().optional(),
  overHost:z.boolean().optional(),
}).strict()
const secret = () => randomBytes(24).toString('base64url')
const equal = (a,b) => typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b))
const progress = snapshot => Object.fromEntries(['seriesId','episodeId','title','label','positionMs','durationMs'].map(k => [k,snapshot[k]]))

/** One controller per local MCP service; panel teardown never owns its native windows. */
export class DetachedPlayers {
  constructor(service, { executable, platform=process.platform, osRelease=platform===process.platform?release():'23', launch=spawn, now=Date.now }={}) {
    this.service=service; this.now=now; this.launch=launch
    this.executable=executable ?? join(projectRoot,'dist/native','darwin-'+process.arch,'HongguoPlayer.app/Contents/MacOS/HongguoPlayer')
    this.supported=platform==='darwin' && Number(osRelease.split('.')[0])>=23 && existsSync(this.executable)
    this.players=new Map(); this.bindings=new Map(); this.media=new Map(); this.closed=false
    this.key=secret()
  }
  binding(scope) { return scope.sessionId ? 'chat:'+scope.sessionId : (scope.windowBinding ??= randomUUID()) }
  find(scope) { return this.players.get(this.bindings.get(this.binding(scope))) }
  blocks(scope,name,args={}) {
    const p=this.find(scope)
    if(p?.phase==='docking' && p.snapshotReady && name==='prepare_playback')return false
    if(p?.phase==='docking' && p.snapshotReady && ['set_source','set_content_preferences'].includes(name) && args.source===parseId(p.snapshot.seriesId).source)return false
    return !!p && p.phase!=='docked' && blockedCommands.has(name)
  }
  player(scope,instance) {
    let p=this.find(scope)
    if (!p) {
      p={ id:randomUUID(), scope, instance, generation:0, phase:'docked', snapshot:null, sourceSeen:0, nativeSeen:0, viewport:null, error:'', media:null }
      this.players.set(p.id,p); this.bindings.set(this.binding(scope),p.id)
    }
    // A newly opened panel in the same chat can recover a detached player.
    if (p.instance!==instance && p.viewport?.visible && this.now()-p.sourceSeen<2500) throw new PlayerError('此播放器已在另一个面板中打开',409)
    p.instance=instance; p.sourceSeen=this.now()
    return p
  }
  view(p) {
    if(p)p.revision=(p.revision??0)+1
    return { supported:this.supported, playerId:p?.id, revision:p?.revision??0,generation:p?.generation??0, phase:p?.phase??'docked',
      snapshot:p?.snapshot, snapshotReady:p?.snapshotReady!==false, error:p?.error??'', dragging:!!p?.dragging }
  }
  async call(scope,name,args) {
    if (name==='get_window_state' && !this.supported) return this.view()
    if (!this.supported) throw new PlayerError('此系统暂不支持独立播放器')
    const p=this.player(scope,args.instance)
    if (name==='get_window_state') {
      p.locale=args.locale??p.locale??'zh-CN'
      if (args.viewport) p.viewport={...args.viewport,at:this.now()}
      if (args.warm) await this.ensureHelper()
      this.reconcile(p)
      return this.view(p)
    }
    if (name==='prepare_desktop_player') {
      await this.ensureHelper()
      if (p.phase!=='docked') return this.view(p)
      if (!scope.allowed?.has(args.episodeId)) throw new PlayerError('请先选择可播放的分集',403)
      const prepared=this.service.catalog.prepare(args.episodeId,true,false)
      if (prepared.status!=='ready') return { status:prepared.status, reason:prepared.reason }
      if (p.media?.episodeId!==args.episodeId) {
        this.releaseMedia(p)
        const token=secret(), media={...prepared,episodeId:args.episodeId,player:p,token}
        p.media=media; this.media.set(token,media)
        this.service.catalog.panelMedia?.pin(args.episodeId,p)
      }
      return {status:'ready'}
    }
    if (name==='detach_player') {
      if (p.phase!=='docked') throw new PlayerError('播放器正在另一个窗口中',409)
      const s=args.snapshot
      if (!matchesSeries(s.seriesId,s.episodeId) || !scope.allowed?.has(s.episodeId) || p.media?.episodeId!==s.episodeId)
        throw new PlayerError('播放内容已改变，请重新移出',409)
      p.snapshot={...s};p.phase='detaching';p.generation++;p.error='';p.snapshotReady=true
      p.dragging=!!args.dragging;p.point=args.point;p.deadline=this.now()+15000;p.run=this.service.store.state(scope.sessionId)
      p.defaultMuted=this.service.preferences().defaultMuted
      this.save(p)
      return this.view(p)
    }
    this.checkGeneration(p,args.generation)
    if (name==='finish_player_drag') {
      p.dragging=false;if(args.point)p.point=args.point
      const v=p.viewport,point=args.point
      const returned=v?.visible && point && this.now()-v.at<10000 && point.x>=v.x && point.x<=v.x+v.width && point.y>=v.y && point.y<=v.y+v.height
      if ((args.cancel||returned) && ['detaching','detached'].includes(p.phase)) this.dock(p)
    } else if (name==='dock_player') {
      if (args.playerId && args.playerId!==p.id) throw new PlayerError('播放器不匹配',403)
      if (p.phase==='detached') this.dock(p)
    } else if (name==='confirm_player_docked') {
      if (p.phase!=='docking' || !p.snapshotReady) throw new PlayerError('播放器尚未准备好返回',409)
      p.phase='docked';p.error='';p.deadline=0;p.dragging=false
      this.releaseMedia(p)
    }
    return this.view(p)
  }
  checkGeneration(p,g) { if(g!==p.generation) throw new PlayerError('播放器已切换窗口，请重试',409) }
  dock(p) {
    p.phase='docking';p.generation++;p.snapshotReady=false;p.dragging=false;p.deadline=this.now()+6000
    if (this.now()-p.nativeSeen>2500) {p.snapshotReady=true;p.snapshot.paused=true}
  }
  save(p) {
    if (!p.snapshot?.durationMs || !this.service.store.persistent) return
    this.service.store.save({...progress(p.snapshot),...(p.snapshot.positionMs===0?{reset:true}:{})})
    this.service.catalog.cache?.hold(p.snapshot.episodeId)
  }
  releaseMedia(p) {
    if(!p.media)return
    this.media.delete(p.media.token);this.service.catalog.panelMedia?.unpin(p.media.episodeId,p);p.media=null
  }
  reconcile(p) {
    if (!p.snapshot || p.phase==='docked') return
    const now=this.now()
    if (p.phase==='detached') {
      const prefs=this.service.preferences(), next=this.service.store.state(p.scope.sessionId), old=p.run
      if(p.hoverResume&&!prefs.hoverDecoyEnabled){p.snapshot.paused=false;p.hoverResume=false;p.control=(p.control??0)+1;p.controlAction='hover-enter'}
      if(p.defaultMuted!==prefs.defaultMuted){p.snapshot.muted=prefs.defaultMuted;p.defaultMuted=prefs.defaultMuted;p.control=(p.control??0)+1;p.controlAction='mute'}
      const stopped=!!old && !!next.turnId && ['stopped','interrupted'].includes(next.state) &&
        (old.turnId!==next.turnId || old.state==='submitted')
      const started=!!old && !!next.turnId && next.state==='submitted' && old.turnId!==next.turnId
      if (stopped && prefs.autoPauseOnFinish) {p.snapshot.paused=true;p.control=(p.control??0)+1;p.controlAction='toggle';p.hoverResume=false}
      else if (started && prefs.autoPlayOnStart) {p.snapshot.paused=false;p.control=(p.control??0)+1;p.controlAction='toggle'}
      p.run=next
      if(now-p.nativeSeen>4500 && p.nativeSeen) {
        p.error='独立窗口已关闭，已保留播放进度';this.dock(p);p.snapshotReady=true;p.snapshot.paused=true
      }
    }
    if (p.deadline && now>p.deadline) {
      if(p.phase==='detaching') {p.error='独立窗口未准备好，已返回面板';p.phase='docking';p.generation++;p.snapshotReady=true;p.snapshot.paused=true;p.deadline=now+6000}
      else if(p.phase==='docking') {
        // No source acknowledgment: keep the native player, never discard its state.
        p.error='请先打开原会话中的播放器，再返回面板';p.phase=p.media?'detached':'docked';p.deadline=0
        if(p.snapshot)p.snapshot.paused=true;p.control=(p.control??0)+1
      }
    }
  }
  nativeView(p) {
    this.reconcile(p)
    const visible=p.phase!=='docked' && this.now()-p.nativeSeen<4500
    if(p.nativeVisible!==visible || this.now()-(p.lastPresence??0)>1800) {
      p.nativeVisible=visible;p.lastPresence=this.now()
      this.service.store.playerVisible?.(p.scope.sessionId,'native-'+p.id,visible)
    }
    const m=p.media
    return {...this.view(p),id:p.id,control:p.control??0,locale:p.locale??'zh-CN',point:p.point,
      viewport:p.viewport && this.now()-p.sourceSeen<2500 && this.now()-p.viewport.at<10000 ? p.viewport:null,
      mediaURL:m ? this.origin+'/media/'+m.token+'/'+(m.format==='dash'?'master.m3u8':'video.mp4') : '',controlAction:p.controlAction??'',
      preferences:this.service.preferences(),sourceAlive:this.now()-p.sourceSeen<2500}
  }
  async event(input) {
    const parsed=nativeEvent.safeParse(input)
    if(!parsed.success)throw new PlayerError('窗口事件无效')
    const e=parsed.data,p=this.players.get(e.playerId)
    if(!p || e.generation!==p.generation)return
    p.nativeSeen=this.now()
    const update=()=>{for(const k of ['positionMs','durationMs','paused','muted','volume','rate'])if(e[k]!==undefined)p.snapshot[k]=e[k]}
    if(e.type==='ready' && p.phase==='detaching') {update();p.phase='detached';p.deadline=0}
    else if(e.type==='progress' && p.phase==='detached') {
      // A state command must be acknowledged before progress may replace its target.
      if(e.control===(p.control??0))update()
      if(this.now()-(p.lastSave??0)>4000){this.save(p);p.lastSave=this.now()}
    } else if(e.type==='frozen' && p.phase==='docking'){update();p.snapshotReady=true;this.save(p)}
    else if(e.type==='error' && p.phase!=='docked') {
      p.error='独立窗口暂时无法播放，已返回面板';this.dock(p);p.snapshotReady=true;p.snapshot.paused=true
    } else if(e.type==='drag-end') {
      p.dragging=false
      if(!e.escaped && e.overHost!==false && e.point && p.viewport?.visible && this.now()-p.sourceSeen<2500 && this.now()-p.viewport.at<10000) {
        const v=p.viewport
        if(e.point.x>=v.x && e.point.x<=v.x+v.width && e.point.y>=v.y && e.point.y<=v.y+v.height && p.phase==='detached')this.dock(p)
      }
    } else if(e.type==='command' && p.phase==='detached') await this.command(p,e)
  }
  async command(p,e) {
    const s=p.snapshot,prefs=this.service.preferences()
    p.controlAction=e.command
    if(e.command==='dock'){this.dock(p);return}
    if(e.command==='toggle'){s.paused=e.paused??!s.paused;p.hoverResume=false}
    else if(e.command==='mute')s.muted=e.muted??!s.muted
    else if(e.command==='seek' && e.positionMs!==undefined)s.positionMs=Math.min(e.positionMs,s.durationMs)
    else if(e.command==='rate' && e.rate!==undefined)s.rate=e.rate
    else if(e.command==='volume' && e.volume!==undefined){s.volume=e.volume;s.muted=e.volume===0;if(e.volume>0)this.service.store.setPreferences({volume:e.volume})}
    else if(e.command==='hover-leave' && prefs.hoverDecoyEnabled){p.hoverResume=!(e.paused??s.paused);s.paused=true}
    else if(e.command==='hover-enter' && prefs.hoverDecoyEnabled){if(p.hoverResume)s.paused=false;p.hoverResume=false}
    else if(['next','previous','ended'].includes(e.command)) {
      if(p.switching)return
      if(e.command==='ended' && !prefs.autoplayNext){s.paused=true;this.save(p)}
      else {p.switching=true;try{await this.next(p,e.command==='previous'?-1:1)}catch{p.error='下一集暂不可播放'}finally{p.switching=false}}
    }
    p.control=(p.control??0)+1
  }
  async next(p,direction) {
    const originalGeneration=p.generation
    let next
    if(direction===1) {
      const result=await this.service.catalog.nextEpisode(p.snapshot.seriesId,p.snapshot.episodeId)
      if(result?.episodeId) {
        let cursor;const seen=new Set()
        do {
          const page=await this.service.catalog.episodes({seriesId:p.snapshot.seriesId,cursor})
          next=page.items.find(row=>row.id===result.episodeId)
          if(next||!page.cursor||seen.has(page.cursor))break
          seen.add(page.cursor);cursor=page.cursor
        }while(cursor)
      }
    } else {
      let cursor,previous;const seen=new Set(),ids=new Set()
      do {
        const page=await this.service.catalog.episodes({seriesId:p.snapshot.seriesId,cursor})
        for(const row of page.items) {
          if(ids.has(row.id))continue
          ids.add(row.id)
          if(row.id===p.snapshot.episodeId){next=previous;break}
          if(row.playable!==false)previous=row
        }
        if(next||ids.has(p.snapshot.episodeId)||!page.cursor||seen.has(page.cursor))break
        seen.add(page.cursor);cursor=page.cursor
      }while(cursor)
    }
    if(p.generation!==originalGeneration || p.phase!=='detached')return
    if(!next?.id || next.playable===false){p.snapshot.paused=true;return}
    p.scope.allowed??=new Set();p.scope.allowed.add(next.id)
    this.save(p);this.releaseMedia(p)
    p.snapshot={...p.snapshot,episodeId:next.id,label:next.label??String(next.number??''),positionMs:0,paused:false}
    p.generation++;p.phase='detaching';p.deadline=this.now()+60000
    const generation=p.generation
    const prepare=async()=>{
      if(this.closed || p.generation!==generation || p.phase!=='detaching')return
      try {
        const r=this.service.catalog.prepare(next.id,true,false)
        if(r.status==='preparing'){const timer=setTimeout(prepare,250);timer.unref();return}
        if(r.status!=='ready')throw new PlayerError('下一集暂不可播放')
        const token=secret(),media={...r,episodeId:next.id,player:p,token}
        p.media=media;this.media.set(token,media);this.service.catalog.panelMedia?.pin(next.id,p)
        if(r.durationMs)p.snapshot.durationMs=r.durationMs
      }catch{p.snapshot.paused=true;p.error='下一集暂不可播放';p.phase='detached';p.deadline=0}
    }
    await prepare()
  }
  async ensureHelper() {
    if(this.closed)throw new PlayerError('独立播放器已关闭')
    if(!this.starting)this.starting=this.listen().catch(error=>{this.starting=null;throw error})
    await this.starting
    if(this.child)return
    const child=this.launch(this.executable,[],{stdio:['pipe','ignore','ignore'],windowsHide:true})
    this.child=child
    // Bootstrap credentials go directly to stdin, never argv, files or diagnostics.
    child.stdin.on('error',()=>{})
    child.stdin.end(JSON.stringify({origin:this.origin,key:this.key}))
    const gone=()=>{if(this.child!==child)return;this.child=null;for(const p of this.players.values())if(p.phase!=='docked'){
      p.error='独立窗口已关闭，已保留播放进度';this.dock(p);p.snapshotReady=true;p.snapshot.paused=true;this.save(p)
    }}
    child.once('error',gone);child.once('exit',gone)
  }
  async listen() {
    this.server=createServer((req,res)=>this.request(req,res).catch(error=>{
      if(res.headersSent){res.destroy();return}
      res.writeHead(error instanceof PlayerError?error.status??400:503,{'Content-Type':'application/json'})
      res.end(JSON.stringify({error:message(error)}))
    }))
    this.server.requestTimeout=15000;this.server.headersTimeout=5000
    await new Promise((ok,no)=>{this.server.once('error',no);this.server.listen(0,'127.0.0.1',ok)})
    this.origin='http://127.0.0.1:'+this.server.address().port
  }
  async request(req,res) {
    res.setHeader('Cache-Control','no-store');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff')
    if(req.headers.host!==new URL(this.origin).host || req.headers.origin)throw new PlayerError('请求来源无效',403)
    const match=/^\/media\/([A-Za-z0-9_-]{32})\/([\w.-]{1,40})$/.exec(req.url)
    if(match && ['GET','HEAD'].includes(req.method)) {
      const media=this.media.get(match[1])
      if(!media)throw new PlayerError('播放地址已失效',404)
      await this.service.syncProviders?.(media.player.scope)
      return serveNativeMedia(this.service.catalog,media,match[2],req,res)
    }
    if(!equal(req.headers.authorization,'Bearer '+this.key))throw new PlayerError('窗口连接无效',403)
    res.setHeader('Content-Type','application/json')
    if(req.url==='/state' && req.method==='GET')return res.end(JSON.stringify({players:[...this.players.values()].map(p=>this.nativeView(p))}))
    if(req.url==='/event' && req.method==='POST') {
      let bytes=0;const parts=[]
      for await(const part of req){bytes+=part.length;if(bytes>8192)throw new PlayerError('窗口事件过大',413);parts.push(part)}
      let input;try{input=JSON.parse(Buffer.concat(parts).toString())}catch{throw new PlayerError('窗口事件无效')}
      await this.event(input);return res.end('{}')
    }
    throw new PlayerError('找不到窗口接口',404)
  }
  close() {
    this.closed=true
    for(const p of this.players.values()){if(p.snapshot)this.save(p);this.releaseMedia(p)}
    this.child?.kill();this.child=null;this.server?.closeAllConnections();this.server?.close()
  }
}
