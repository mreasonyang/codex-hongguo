import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const code=transformSync(readFileSync(new URL('../src/ui/desktop-player.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code
const snapshot={seriesId:'hg-1',episodeId:'hg-11',title:'Test',label:'1',positionMs:12000,durationMs:60000,paused:false,muted:true,volume:0.7,rate:1}
const docked={supported:true,playerId:'player-a',revision:1,generation:0,phase:'docked'}
const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve()}
function setup(call,options={},clock){
  class Element extends EventTarget {
    hidden=false;disabled=false;classes=new Set()
    classList={toggle:(key,on)=>on?this.classes.add(key):this.classes.delete(key),add:key=>this.classes.add(key),remove:key=>this.classes.delete(key)}
    setAttribute(){} setPointerCapture(){} releasePointerCapture(){} contains(target){return target===this}
  }
  const elements=new Map(),document=Object.assign(new EventTarget(),{hidden:false,body:new Element(),documentElement:new Element(),getElementById(id){if(!elements.has(id))elements.set(id,new Element());return elements.get(id)}})
  const window=Object.assign(new EventTarget(),{screenX:0,screenY:0,innerWidth:400,innerHeight:600})
  const exports={},scope=vm.createContext({module:{exports},exports,document,window,
    setTimeout:clock?.setTimeout??setTimeout,clearTimeout:clock?.clearTimeout??clearTimeout,Date:clock?{now:()=>clock.time}:Date,
    require:name=>name==='./api'?{browser:false,call,hostLocale:()=> 'zh-CN'}:{tr:s=>s}})
  vm.runInContext(code,scope)
  const counts={freeze:0,restore:0},ui=scope.module.exports.createDesktopPlayer({instance:'panel-a',snapshot:()=>snapshot,
    freeze:async()=>{counts.freeze++;return snapshot},restore:async()=>{counts.restore++},notice(){},...options})
  return{ui,counts,document,window,elements,
    event(target,type,props={}){const event=Object.assign(new Event(type,{cancelable:true}),props);target.dispatchEvent(event);return event},
  }
}
function fakeClock(){
  let id=0;const jobs=new Map(),clock={time:0,
    setTimeout(fn,ms){const next=++id;jobs.set(next,{at:clock.time+ms,fn});return next},clearTimeout(id){jobs.delete(id)},
    async advance(ms){const end=clock.time+ms;for(;;){const next=[...jobs].filter(([,job])=>job.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;clock.time=next[1].at;jobs.delete(next[0]);next[1].fn();await flush()}clock.time=end;await flush()},
  };return clock
}
const pointer={pointerId:1,button:0,clientX:100,clientY:300,screenX:100,screenY:300}
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
test('dragging inside the sidebar only shows a cue; detachment starts after crossing its edge',async()=>{
  let prepares=0,detaches=0
  const f=setup(async name=>{
    if(name==='get_window_state')return docked
    if(name==='prepare_desktop_player'){prepares++;return{status:'ready'}}
    if(name==='detach_player'){detaches++;return{...docked,revision:2,generation:1,phase:'detaching',snapshot}}
    throw Error('Unexpected call')
  })
  await f.ui.start()
  const pointer={pointerId:1,button:0,clientX:100,clientY:100,screenX:100,screenY:100}
  f.event(f.elements.get('desktopHandle'),'pointerdown',pointer)
  f.event(f.document,'pointermove',{...pointer,clientX:350,screenX:350});await flush()
  assert.equal(prepares,0);assert.equal(f.ui.external(),false)
  assert.equal(f.elements.get('desktopDragHint').hidden,false)
  f.event(f.document,'pointerup',{...pointer,clientX:350,screenX:350})
  assert.equal(f.elements.get('desktopDragHint').hidden,true)
  f.event(f.elements.get('desktopHandle'),'pointerdown',pointer)
  f.event(f.document,'pointermove',{...pointer,clientX:411,screenX:411});await flush()
  assert.equal(prepares,0,'releasing near the edge must not pop out a window')
  f.event(f.document,'pointermove',{...pointer,clientX:413,screenX:413});await flush()
  assert.equal(prepares,1);assert.equal(detaches,1);assert.equal(f.ui.external(),true)
})
test('a three-second hold anywhere arms dragging, then crossing the sidebar transfers playback once',async()=>{
  const clock=fakeClock();let prepares=0,detaches=0
  const native={...docked,revision:2,generation:1,phase:'detaching',snapshot}
  const f=setup(async name=>{
    if(name==='get_window_state')return docked
    if(name==='prepare_desktop_player'){prepares++;return{status:'ready'}}
    if(name==='detach_player'){detaches++;return native}
    if(name==='finish_player_drag')return native
    throw Error('Unexpected call')
  },{},clock)
  await f.ui.start();f.event(f.document,'pointerdown',pointer)
  await clock.advance(2999)
  assert.equal(f.document.documentElement.classes.has('desktopHolding'),true)
  assert.equal(f.document.documentElement.classes.has('desktopDragging'),false)
  assert.equal(prepares,0)
  await clock.advance(1)
  assert.equal(f.document.documentElement.classes.has('desktopDragging'),true)
  assert.match(f.elements.get('desktopDragHint').textContent,/已可拖拽/)
  assert.equal(f.ui.external(),false,'holding only arms the gesture, without stopping playback')
  f.event(f.document,'pointermove',{...pointer,clientX:413,screenX:413});await flush()
  assert.equal(prepares,1);assert.equal(detaches,1);assert.equal(f.counts.freeze,1)
  f.event(f.document,'pointerup',{...pointer,clientX:413,screenX:413});await flush()
})
test('short clicks and scrubbing motions do not become long presses',async()=>{
  for(const move of [false,true]){
    const clock=fakeClock(),f=setup(async name=>{assert.equal(name,'get_window_state');return docked},{},clock)
    await f.ui.start();const down=f.event(f.document,'pointerdown',pointer)
    if(move)f.event(f.document,'pointermove',{...pointer,clientX:109,screenX:109})
    else {await clock.advance(200);f.event(f.document,'pointerup',pointer)}
    await clock.advance(4000)
    assert.equal(down.defaultPrevented,false)
    assert.equal(f.document.documentElement.classes.has('desktopDragging'),false)
    assert.equal(f.event(f.document,'click',{detail:1}).defaultPrevented,false)
  }
})
test('releasing after a long hold consumes its click while normal and keyboard clicks still work',async()=>{
  const clock=fakeClock(),f=setup(async()=>docked,{},clock)
  await f.ui.start();f.event(f.document,'pointerdown',pointer);await clock.advance(3000)
  f.event(f.document,'pointerup',pointer)
  assert.equal(f.event(f.document,'click',{detail:0}).defaultPrevented,false)
  assert.equal(f.event(f.document,'click',{detail:1}).defaultPrevented,true,'release must not also pause the video or click a button')
  f.event(f.document,'pointerdown',pointer);f.event(f.document,'pointerup',pointer)
  assert.equal(f.event(f.document,'click',{detail:1}).defaultPrevented,false)
})
test('Escape, scroll, blur, hidden pages and disposal clear pending long presses',async()=>{
  for(const reason of ['Escape','scroll','blur','hidden','dispose']){
    const clock=fakeClock(),f=setup(async()=>docked,{},clock)
    await f.ui.start();f.event(f.document,'pointerdown',pointer);await clock.advance(800)
    if(reason==='Escape')f.event(f.document,'keydown',{key:'Escape'})
    else if(reason==='scroll')f.event(f.document,'scroll')
    else if(reason==='blur')f.event(f.window,'blur')
    else if(reason==='hidden'){f.document.hidden=true;f.event(f.document,'visibilitychange')}
    else f.ui.dispose()
    await clock.advance(4000)
    assert.equal(f.document.documentElement.classes.has('desktopDragging'),false,reason)
    assert.equal(f.elements.get('desktopDragHint').hidden,true,reason)
  }
})
test('a missed pointer-up cannot leave a long press armed after the mouse is released',async()=>{
  const clock=fakeClock(),f=setup(async()=>docked,{},clock)
  await f.ui.start();f.event(f.document,'pointerdown',pointer);await clock.advance(3000)
  f.event(f.document,'pointermove',{...pointer,buttons:0})
  assert.equal(f.document.documentElement.classes.has('desktopDragging'),false)
  assert.equal(f.elements.get('desktopDragHint').hidden,true)
  assert.equal(f.ui.external(),false)
})
