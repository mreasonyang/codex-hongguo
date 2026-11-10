import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { Store } from '../src/server/store.mjs'
import { Service } from '../src/server/service.mjs'
import { DetachedPlayers } from '../src/server/detached.mjs'
import { nativePlaylists } from '../src/server/native-media.mjs'

const snapshot={seriesId:'hg-1',episodeId:'hg-11',title:'Test',label:'1',positionMs:12000,durationMs:60000,paused:false,muted:true,volume:0.7,rate:1}
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'hongguo-detached-')),store=new Store(root)
  let now=100000,child,launches=0
  const catalog={prepare:()=>({status:'ready',src:'media/hg-11'}),cache:{hold(){}},panelMedia:{pin(){},unpin(){}},
    nextEpisode:async()=>({episodeId:'hg-12',kind:'next'}),
    episodes:async()=>({items:[{id:'hg-11',label:'1',playable:true},{id:'hg-12',label:'2',playable:true}],cursor:null})}
  const service=new Service(store,catalog)
  const desktop=new DetachedPlayers(service,{platform:'darwin',executable:process.execPath,now:()=>now,launch(){
    launches++;child=new EventEmitter();child.stdin=new EventEmitter();child.stdin.end=()=>{};child.kill=()=>{};return child
  }})
  service.detached=desktop
  const scope=service.panel(service.open({threadId:'chat-a'}).panel);scope.allowed=new Set(['hg-11'])
  const call=(name,input={})=>service.call(scope,name,{instance:'panel-a',...input})
  t.after(()=>{desktop.close();store.close();rmSync(root,{recursive:true,force:true})})
  return {store,service,scope,desktop,call,advance:ms=>{now+=ms},child:()=>child,launches:()=>launches,
    async detach(extra={}){await call('prepare_desktop_player',{episodeId:'hg-11'});return call('detach_player',{snapshot,...extra})},
    async ready(state,extra={}){await desktop.event({type:'ready',playerId:state.playerId,generation:state.generation,...extra})},
  }
}
test('detached owner fences original playback and stale writes; frozen acknowledgment restores exact progress',async t=>{
  const f=fixture(t),s=await f.detach();await f.ready(s)
  await assert.rejects(f.service.call(f.scope,'save_progress',snapshot),/请求参数无效/)
  const {paused,muted,volume,rate,...oldProgress}=snapshot
  await assert.rejects(f.service.call(f.scope,'save_progress',oldProgress),/播放器已移到桌面/)
  await assert.rejects(f.service.call(f.scope,'prepare_playback',{episodeId:'hg-11'}),/播放器已移到桌面/)
  const docking=await f.call('dock_player',{generation:s.generation})
  await assert.rejects(f.call('confirm_player_docked',{generation:docking.generation}),/尚未准备/)
  await f.desktop.event({type:'frozen',playerId:s.playerId,generation:s.generation,positionMs:5000})
  assert.equal(f.desktop.find(f.scope).snapshotReady,false,'old native reply cannot complete a newer migration')
  await f.desktop.event({type:'frozen',playerId:s.playerId,generation:docking.generation,positionMs:27000,paused:true})
  const restored=await f.call('confirm_player_docked',{generation:docking.generation})
  assert.equal(restored.phase,'docked');assert.equal(restored.snapshot.positionMs,27000)
  assert.equal(f.store.history('hg-1','hg-11')[0].positionMs,27000)
  assert.equal(f.desktop.media.size,0,'media authorization is revoked on successful return')
})
test('other chats cannot recover or dock a player, and unselected media cannot be moved',async t=>{
  const f=fixture(t)
  await assert.rejects(f.call('prepare_desktop_player',{episodeId:'hg-12'}),/请先选择/)
  const s=await f.detach();await f.ready(s)
  const peer=f.service.panel(f.service.open({threadId:'chat-b'}).panel)
  const peerState=await f.service.call(peer,'get_window_state',{instance:'panel-b'})
  assert.notEqual(peerState.playerId,s.playerId)
  await assert.rejects(f.service.call(peer,'dock_player',{instance:'panel-b',generation:0,playerId:s.playerId}),/不匹配/)
})
test('newer native commands cannot be overwritten by progress sampled before the command',async t=>{
  const f=fixture(t),s=await f.detach();await f.ready(s)
  await f.desktop.event({type:'command',playerId:s.playerId,generation:s.generation,command:'seek',positionMs:35000})
  await f.desktop.event({type:'progress',playerId:s.playerId,generation:s.generation,control:0,positionMs:14000})
  assert.equal(f.desktop.find(f.scope).snapshot.positionMs,35000)
  await f.desktop.event({type:'progress',playerId:s.playerId,generation:s.generation,control:1,positionMs:36000})
  assert.equal(f.desktop.find(f.scope).snapshot.positionMs,36000)
})
test('native next uses the catalog episodeId contract and previous crosses page boundaries',async t=>{
  const f=fixture(t),s=await f.detach();await f.ready(s)
  await f.desktop.event({type:'command',playerId:s.playerId,generation:s.generation,command:'next'})
  const next=await f.call('get_window_state')
  assert.equal(next.snapshot.episodeId,'hg-12');assert.equal(next.phase,'detaching')
  await f.ready(next)
  f.service.catalog.episodes=async({cursor})=>cursor?{items:[{id:'hg-12',label:'2',playable:true}],cursor:null}:{items:[{id:'hg-11',label:'1',playable:true}],cursor:'page-2'}
  await f.desktop.event({type:'command',playerId:s.playerId,generation:next.generation,command:'previous'})
  assert.equal((await f.call('get_window_state')).snapshot.episodeId,'hg-11')
})
test('a fresh panel can restore the native source after the old panel goes away',async t=>{
  const f=fixture(t),s=await f.detach();await f.ready(s)
  await f.call('get_window_state',{viewport:{x:100,y:100,width:400,height:600,visible:true}})
  await assert.rejects(f.service.call(f.scope,'get_window_state',{instance:'fresh-panel'}),/另一个面板/)
  f.advance(3000)
  const fresh=f.service.panel(f.service.open({threadId:'chat-a'}).panel)
  let state=await f.service.call(fresh,'get_window_state',{instance:'fresh-panel'})
  assert.equal(state.playerId,s.playerId)
  state=await f.service.call(fresh,'dock_player',{instance:'fresh-panel',generation:s.generation})
  await f.desktop.event({type:'frozen',playerId:s.playerId,generation:state.generation,positionMs:40000,paused:true})
  assert.equal(f.desktop.blocks(fresh,'set_source',{source:'hongguo'}),false)
  assert.equal(f.desktop.blocks(fresh,'set_source',{source:'bilibili'}),true)
  assert.equal((await f.service.call(fresh,'confirm_player_docked',{instance:'fresh-panel',generation:state.generation})).phase,'docked')
})
test('a delayed next-episode lookup cannot switch a player after it has returned to the panel',async t=>{
  const f=fixture(t),s=await f.detach();await f.ready(s)
  let resolveNext
  f.service.catalog.nextEpisode=()=>new Promise(ok=>{resolveNext=ok})
  const next=f.desktop.event({type:'command',playerId:s.playerId,generation:s.generation,command:'next'})
  await f.call('dock_player',{generation:s.generation})
  resolveNext({episodeId:'hg-12',kind:'next'});await next
  const state=await f.call('get_window_state')
  assert.equal(state.phase,'docking');assert.equal(state.snapshot.episodeId,'hg-11')
})
test('native playback follows each new turn once and consumes terminal transitions once',async t=>{
  const f=fixture(t)
  f.store.event({session_id:'chat-a',turn_id:'turn-a',hook_event_name:'UserPromptSubmit'})
  const s=await f.detach();await f.ready(s)
  f.store.event({session_id:'chat-a',turn_id:'turn-a',hook_event_name:'Stop'})
  let state=await f.call('get_window_state');assert.equal(state.snapshot.paused,true)
  await f.desktop.event({type:'command',playerId:s.playerId,generation:s.generation,command:'toggle'})
  state=await f.call('get_window_state');assert.equal(state.snapshot.paused,false,'manual play after Stop is allowed')
  await f.desktop.event({type:'command',playerId:s.playerId,generation:s.generation,command:'toggle'})
  f.store.event({session_id:'chat-a',turn_id:'turn-b',hook_event_name:'UserPromptSubmit'})
  state=await f.call('get_window_state');assert.equal(state.snapshot.paused,false)
  f.store.event({session_id:'chat-a',turn_id:'turn-b',hook_event_name:'Interrupt'})
  state=await f.call('get_window_state');assert.equal(state.snapshot.paused,true)
})
test('failed helper, missing source and delayed preparation preserve a paused recovery snapshot',async t=>{
  const f=fixture(t),s=await f.detach()
  f.child().emit('exit',1)
  let state=await f.call('get_window_state')
  assert.equal(state.phase,'docking');assert.equal(state.snapshotReady,true);assert.equal(state.snapshot.paused,true)
  await f.call('confirm_player_docked',{generation:state.generation})
  const second=await f.detach();f.advance(16000)
  state=await f.call('get_window_state')
  assert.equal(state.phase,'docking');assert.equal(state.snapshotReady,true)
  assert.equal(state.snapshot.positionMs,snapshot.positionMs)
  await assert.rejects(f.call('confirm_player_docked',{generation:second.generation}),/已切换窗口/)
})
test('cancel and release over the sidebar request return, but release on desktop leaves the native owner',async t=>{
  const f=fixture(t)
  await f.call('get_window_state',{viewport:{x:100,y:100,width:400,height:600,visible:true}})
  const s=await f.detach({dragging:true});await f.ready(s)
  let state=await f.call('finish_player_drag',{generation:s.generation,point:{x:800,y:300}})
  assert.equal(state.phase,'detached')
  state=await f.call('finish_player_drag',{generation:s.generation,point:{x:200,y:200}})
  assert.equal(state.phase,'docking')
})
test('native controller accepts only its private pipe-bootstrap authority and no browser origins',async t=>{
  const f=fixture(t);await f.call('get_window_state',{warm:true})
  const origin=f.desktop.origin
  assert.equal((await fetch(origin+'/state')).status,403)
  assert.equal((await fetch(origin+'/state',{headers:{Origin:'https://example.com'}})).status,403)
  assert.equal((await fetch(origin+'/media/invalid/video.mp4')).status,403)
  assert.equal(f.launches(),1)
  await f.call('get_window_state',{warm:true});assert.equal(f.launches(),1)
})
test('DASH cache becomes separate, seekable audio/video HLS renditions without upstream URLs',()=>{
  const tracks=['video','audio'].map((name,i)=>({mime:i?'audio/mp4; codecs="mp4a.40.2"':'video/mp4; codecs="avc1.640028"',
    initialization:name+'-init.mp4',segments:[{asset:name+'-00000.m4s',time:0,duration:2.4},{asset:name+'-00001.m4s',time:2.4,duration:1.3}]}))
  const result=nativePlaylists(JSON.stringify({version:1,tracks}))
  assert.match(result.get('master.m3u8'),/GROUP-ID="audio"/)
  assert.match(result.get('master.m3u8'),/avc1.640028,mp4a.40.2/)
  assert.match(result.get('video.m3u8'),/#EXT-X-TARGETDURATION:3/)
  assert.match(result.get('audio.m3u8'),/#EXT-X-MAP:URI="audio-init.mp4"/)
  assert.match(result.get('audio.m3u8'),/#EXT-X-ENDLIST/)
  tracks[0].segments[0].asset='../private'
  assert.throws(()=>nativePlaylists(JSON.stringify({version:1,tracks})),/无效/)
})
