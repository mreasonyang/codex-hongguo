import { browser, call, hostLocale } from './api'
import { tr } from './locale'

export type DesktopSnapshot = { seriesId:string;episodeId:string;title:string;label:string;positionMs:number;durationMs:number;paused:boolean;muted:boolean;volume:number;rate:number }
type Point={x:number;y:number}
type WindowState={supported:boolean;playerId?:string;revision?:number;generation:number;phase:'docked'|'detaching'|'detached'|'docking';snapshot?:DesktopSnapshot;snapshotReady?:boolean;error?:string}
type Options={instance:string;snapshot:()=>DesktopSnapshot|null;freeze:()=>Promise<DesktopSnapshot|null>;restore:(s:DesktopSnapshot)=>Promise<void>;notice:(s:string)=>void}

/** The original view remains mounted as a drop target while its renderer is idle. */
export function createDesktopPlayer(options:Options) {
  const button=document.getElementById('detach') as HTMLButtonElement|null
  const handle=document.getElementById('desktopHandle')
  const slot=document.getElementById('desktopSlot')
  const hint=document.getElementById('desktopHint')
  const recover=document.getElementById('desktopReturn')
  let state:WindowState={supported:false,generation:0,phase:'docked'}
  let enabled=false, disposed=false, refreshing:Promise<void>|undefined, moving=false, restoring=-1
  let anchor:{x:number;y:number;hostX:number;hostY:number}|undefined
  let gesture:{id:number;x:number;y:number;point:Point;active:boolean;ended:boolean;canceled:boolean}|undefined
  let moveTicket=0
  const external=()=>state.phase!=='docked' || moving
  function viewport() {
    if(!anchor)return undefined
    return {x:anchor.x+(window.screenX-anchor.hostX),y:anchor.y+(window.screenY-anchor.hostY),
      width:window.innerWidth,height:window.innerHeight,visible:!document.hidden && enabled}
  }
  function calibrate(e:PointerEvent) {
    if(!Number.isFinite(e.screenX)||!Number.isFinite(e.clientX))return
    anchor={x:e.screenX-e.clientX,y:e.screenY-e.clientY,hostX:window.screenX,hostY:window.screenY}
  }
  function render() {
    if(button){button.hidden=!state.supported||browser;button.disabled=moving||state.phase!=='docked';button.title=tr('移到桌面');button.setAttribute('aria-label',tr('移到桌面'))}
    handle?.classList.toggle('canDetach',state.supported&&!browser)
    document.documentElement.classList.toggle('desktopDetached',state.phase!=='docked')
    if(slot)slot.hidden=state.phase==='docked'
    if(hint){hint.textContent=tr(state.error || (state.phase==='docking'?'正在返回播放器…':'拖回这里恢复播放'));hint.hidden=!state.error&&state.phase!=='docking'}
    if(recover)recover.hidden=state.phase!=='detached' && state.phase!=='detaching'
  }
  async function apply(next:WindowState) {
    if(disposed)return
    if(next.playerId===state.playerId && next.generation<state.generation)return
    if(next.playerId===state.playerId && next.revision!==undefined && state.revision!==undefined && next.revision<state.revision)return
    state=next;render()
    if(next.phase==='docking' && next.snapshotReady && next.snapshot && restoring!==next.generation) {
      const generation=next.generation;restoring=generation
      try {
        await options.restore(next.snapshot)
        if(disposed||state.generation!==generation)return
        const confirmed=await call<WindowState>('confirm_player_docked',{instance:options.instance,generation})
        if(state.generation===generation){state=confirmed;moving=false;render();if(next.error)options.notice(next.error)}
      } catch(error) { await options.freeze().catch(()=>{});restoring=-1;options.notice(error instanceof Error?error.message:'返回面板失败，请重试') }
    }
  }
  async function refresh(warm=false) {
    if(!enabled||disposed||browser)return
    refreshing??=call<WindowState>('get_window_state',{instance:options.instance,warm,locale:hostLocale(),viewport:viewport()},5000)
      .then(apply).catch(()=>{}).finally(()=>{refreshing=undefined})
    return refreshing
  }
  async function finishGesture(g:NonNullable<typeof gesture>) {
    if(!state.generation||state.phase==='docked')return
    await call<WindowState>('finish_player_drag',{instance:options.instance,generation:state.generation,cancel:g.canceled,point:g.point}).then(apply).catch(()=>{})
  }
  async function detach(g?:NonNullable<typeof gesture>) {
    if(moving||!state.supported||state.phase!=='docked')return
    const selected=options.snapshot();if(!selected)return
    const ticket=++moveTicket;moving=true;render()
    try {
      const until=Date.now()+15000
      for(;;) {
        const prepared=await call<{status:string;reason?:string}>('prepare_desktop_player',{instance:options.instance,episodeId:selected.episodeId},10000)
        if(ticket!==moveTicket||g?.canceled||disposed)return
        if(prepared.status==='ready')break
        if(prepared.status==='error'||Date.now()>until)throw Error(prepared.reason||'独立窗口准备超时，请重试')
        await new Promise(resolve=>setTimeout(resolve,200))
      }
      let snapshot=options.snapshot()
      if(!snapshot||snapshot.episodeId!==selected.episodeId)return
      snapshot=await options.freeze()??snapshot
      if(ticket!==moveTicket||g?.canceled||disposed){await options.restore(snapshot);return}
      const next=await call<WindowState>('detach_player',{instance:options.instance,snapshot,dragging:!!g&&!g.ended,point:g?.point},10000)
      await apply(next)
      if(g?.ended)await finishGesture(g)
    } catch(error) {
      // A lost response may still have transferred ownership; reconcile before resuming.
      await refresh()
      if(state.phase==='docked')await options.restore(selected).catch(()=>{})
      options.notice(error instanceof Error?error.message:'独立窗口暂不可用')
    } finally {moving=false;render()}
  }
  function pointerDown(e:PointerEvent) {
    if(!state.supported||browser||e.button!==0||state.phase!=='docked'||!options.snapshot())return
    calibrate(e)
    gesture={id:e.pointerId,x:e.clientX,y:e.clientY,point:{x:e.screenX,y:e.screenY},active:false,ended:false,canceled:false}
    try{document.body.setPointerCapture(e.pointerId)}catch{}
  }
  function pointerMove(e:PointerEvent) {
    if(!gesture||e.pointerId!==gesture.id){calibrate(e);return}
    const g=gesture;g.point={x:e.screenX,y:e.screenY}
    if(!g.active && Math.hypot(e.clientX-g.x,e.clientY-g.y)>24){
      g.active=true;document.documentElement.classList.add('desktopDragging');void detach(g)
    }
  }
  function pointerEnd(e:PointerEvent) {
    if(!gesture||e.pointerId!==gesture.id)return
    const g=gesture;g.ended=true;g.canceled=e.type==='pointercancel';g.point={x:e.screenX,y:e.screenY}
    document.documentElement.classList.remove('desktopDragging')
    try{document.body.releasePointerCapture(e.pointerId)}catch{}
    if(g.active && !moving)void finishGesture(g)
    gesture=undefined
  }
  function cancel(e:KeyboardEvent) {
    if(e.key!=='Escape'||!gesture)return
    const g=gesture;g.canceled=true;g.ended=true;gesture=undefined;document.documentElement.classList.remove('desktopDragging')
    if(!moving)void finishGesture(g)
  }
  function dragOver(e:DragEvent) {
    if(state.phase!=='detached'||!e.dataTransfer?.types.includes('text/plain'))return
    e.preventDefault();e.dataTransfer.dropEffect='move';slot?.classList.add('dragOver');if(hint)hint.hidden=false
  }
  function drop(e:DragEvent) {
    slot?.classList.remove('dragOver')
    if(e.dataTransfer?.getData('text/plain')!=='hongguo-player:'+state.playerId)return
    e.preventDefault();e.stopPropagation()
    void call<WindowState>('dock_player',{instance:options.instance,generation:state.generation,playerId:state.playerId}).then(apply).catch(error=>options.notice(String(error)))
  }
  const onClick=()=>{void detach()}
  const onRecover=()=>{void call<WindowState>('dock_player',{instance:options.instance,generation:state.generation}).then(apply).catch(()=>{})}
  button?.addEventListener('click',onClick);handle?.addEventListener('pointerdown',pointerDown)
  document.addEventListener('pointermove',pointerMove);document.addEventListener('pointerup',pointerEnd);document.addEventListener('pointercancel',pointerEnd)
  document.addEventListener('keydown',cancel);slot?.addEventListener('dragover',dragOver);slot?.addEventListener('drop',drop)
  slot?.addEventListener('dragleave',()=>{slot.classList.remove('dragOver');if(hint&&!state.error)hint.hidden=true})
  recover?.addEventListener('click',onRecover)
  return {
    external,
    async start(){enabled=true;await refresh(true)},
    refresh,
    suspend(){enabled=false;if(anchor)void call('get_window_state',{instance:options.instance,viewport:{...viewport()!,visible:false}}).catch(()=>{})},
    resume(){enabled=true;void refresh()},
    dispose(){disposed=true;enabled=false;moveTicket++;document.removeEventListener('pointermove',pointerMove);document.removeEventListener('pointerup',pointerEnd);document.removeEventListener('pointercancel',pointerEnd);document.removeEventListener('keydown',cancel)},
  }
}
