import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const code=transformSync(readFileSync(new URL('../src/ui/desktop-player.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code
const snapshot={seriesId:'hg-1',episodeId:'hg-11',title:'Test',label:'1',positionMs:12000,durationMs:60000,paused:false,muted:true,volume:0.7,rate:1}
const docked={supported:true,playerId:'player-a',revision:1,generation:0,phase:'docked'}
const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve()}
function setup(call,options={}){
  class Element extends EventTarget {
    hidden=false;disabled=false;classes=new Set()
    classList={toggle:(key,on)=>on?this.classes.add(key):this.classes.delete(key),add:key=>this.classes.add(key),remove:key=>this.classes.delete(key)}
    setAttribute(){} setPointerCapture(){} releasePointerCapture(){}
  }
  const elements=new Map(),document=Object.assign(new EventTarget(),{hidden:false,body:new Element(),documentElement:new Element(),getElementById(id){if(!elements.has(id))elements.set(id,new Element());return elements.get(id)}})
  const exports={},scope=vm.createContext({module:{exports},exports,document,window:{screenX:0,screenY:0,innerWidth:400,innerHeight:600},setTimeout,clearTimeout,
    require:name=>name==='./api'?{browser:false,call,hostLocale:()=> 'zh-CN'}:{tr:s=>s}})
  vm.runInContext(code,scope)
  const counts={freeze:0,restore:0},ui=scope.module.exports.createDesktopPlayer({instance:'panel-a',snapshot:()=>snapshot,
    freeze:async()=>{counts.freeze++;return snapshot},restore:async()=>{counts.restore++},notice(){},...options})
  return{ui,counts,document,elements,
    event(target,type,props={}){target.dispatchEvent(Object.assign(new Event(type),props))},
  }
}
test('a delayed panel refresh cannot reclaim ownership after a newer detach response',async()=>{
  let reads=0,resolveRefresh
  const f=setup(async name=>{
    if(name==='get_window_state'){if(++reads===1)return docked;return new Promise(ok=>{resolveRefresh=ok})}
    if(name==='prepare_desktop_player')return{status:'ready'}
    if(name==='detach_player')return{...docked,generation:1,revision:3,phase:'detaching',snapshot}
    throw Error('Unexpected call')
  })
  await f.ui.start();const refresh=f.ui.refresh()
  f.event(f.elements.get('detach'),'click');await flush()
  assert.equal(f.counts.freeze,1);assert.equal(f.ui.external(),true)
  resolveRefresh({...docked,revision:2});await refresh
  assert.equal(f.ui.external(),true);assert.equal(f.elements.get('desktopSlot').hidden,false)
})
test('a lost docking acknowledgment freezes the source before retrying restoration',async()=>{
  let confirms=0
  const f=setup(async name=>{
    if(name==='get_window_state')return{...docked,generation:2,revision:4,phase:'docking',snapshotReady:true,snapshot}
    if(name==='confirm_player_docked'){if(++confirms===1)throw Error('Connection lost');return{...docked,generation:2,revision:5}}
    throw Error('Unexpected call')
  })
  await f.ui.start()
  assert.equal(f.counts.restore,1);assert.equal(f.counts.freeze,1);assert.equal(f.ui.external(),true)
  await f.ui.refresh()
  assert.equal(f.counts.restore,2);assert.equal(f.ui.external(),false)
})
test('Escape during asynchronous preparation keeps the original renderer and avoids a late detach',async()=>{
  let prepared,detaches=0
  const f=setup(async name=>{
    if(name==='get_window_state')return docked
    if(name==='prepare_desktop_player')return new Promise(ok=>{prepared=ok})
    if(name==='detach_player'){detaches++;throw Error('Canceled gesture detached')}
    throw Error('Unexpected call')
  })
  await f.ui.start()
  const pointer={pointerId:1,button:0,clientX:100,clientY:100,screenX:100,screenY:100}
  f.event(f.elements.get('desktopHandle'),'pointerdown',pointer)
  f.event(f.document,'pointermove',{...pointer,clientX:600,screenX:600})
  await flush();f.event(f.document,'keydown',{key:'Escape'});prepared({status:'ready'});await flush()
  assert.equal(detaches,0);assert.equal(f.counts.freeze,0);assert.equal(f.ui.external(),false)
})
