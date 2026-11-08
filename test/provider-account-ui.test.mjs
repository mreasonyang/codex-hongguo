import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

const code=transformSync(readFileSync(new URL('../src/ui/provider-account.ts',import.meta.url),'utf8'),{loader:'ts',format:'cjs'}).code
const flush=async()=>{for(let i=0;i<40;i++) await Promise.resolve()}
function fixture() {
  const elements=new Map(), timers=new Map(), requests=[], revoked=[], updates=[]
  let next=0
  const get=id=>{
    if(!elements.has(id)) elements.set(id,{hidden:false,disabled:false,textContent:'',removeAttribute(name){delete this[name]}})
    return elements.get(id)
  }
  const state={status:{status:'signed-out'},poll:{status:'waiting'},start:{status:'waiting',loginId:'opaque-session',svg:'<svg/>',expiresAt:Date.now()+180000}}
  const call=async(name,args)=>{
    requests.push({name,args})
    if(name==='get_provider_auth') return state.status
    if(name==='start_provider_login') return state.start
    if(name==='poll_provider_login') return state.poll
    if(name==='logout_provider') return {status:'signed-out'}
    return {status:'cancelled'}
  }
  const exports={}, context=vm.createContext({module:{exports},exports,Blob,Date,
    document:{getElementById:get},URL:{createObjectURL:()=> 'blob:synthetic-qr',revokeObjectURL:url=>revoked.push(url)},
    setTimeout(fn,ms){timers.set(++next,{fn,ms});return next},clearTimeout(id){timers.delete(id)},
    require(name){if(name==='./api') return {call};if(name==='./locale') return {tr:s=>s};throw Error('unexpected import')},
  })
  vm.runInContext(code,context)
  const account=new context.module.exports.ProviderAccount(async value=>{updates.push(value)})
  return {account,get,state,requests,revoked,updates,async tick(ms){
    const entry=[...timers].find(([,timer])=>timer.ms===ms)
    assert.ok(entry,'expected timer');timers.delete(entry[0]);await entry[1].fn();await flush()
  }}
}
test('account UI shows QR, scanned state, successful identity and signs out with no cookie in browser calls',async()=>{
  const f=fixture();await f.account.show('bilibili')
  assert.equal(f.get('providerAccount').hidden,false)
  assert.match(f.get('accountStatus').textContent,/未登录/)
  await f.account.start()
  assert.equal(f.get('accountQr').src,'blob:synthetic-qr')
  assert.equal(f.get('accountQrArea').hidden,false)
  f.state.poll={status:'scanned'};await f.tick(2000)
  assert.match(f.get('accountStatus').textContent,/手机上确认/)
  f.state.poll={status:'signed-in',name:'Test account',vip:true};await f.tick(2200)
  assert.equal(f.get('accountQrArea').hidden,true)
  assert.equal(f.get('accountName').textContent,'Test account')
  assert.equal(f.get('accountLogin').hidden,true)
  assert.deepEqual(f.updates,[true]);assert.equal(f.revoked.length,1)
  await f.account.logout()
  assert.equal(f.get('accountLogin').hidden,false)
  assert.deepEqual(f.updates,[true,false])
  assert.equal(f.requests.some(request=>JSON.stringify(request).includes('cookie')),false)
  f.account.hide()
})
test('closing settings cancels the owner session, revokes its image and ignores late poll completion',async()=>{
  const f=fixture();await f.account.show('bilibili');await f.account.start()
  let resolve
  f.state.poll=new Promise(done=>{resolve=done})
  const pending=f.tick(2000);await flush()
  f.account.hide();resolve({status:'signed-in',name:'Late account'})
  await pending
  assert.equal(f.get('providerAccount').hidden,true)
  assert.equal(f.get('accountQr').src,undefined)
  assert.deepEqual(f.updates,[])
  assert.equal(f.requests.some(request=>request.name==='cancel_provider_login'),true)
})
test('late QR creation is cancelled after the settings sheet is closed and expiry clears its image',async()=>{
  const f=fixture();await f.account.show('bilibili')
  let resolve
  f.state.start=new Promise(done=>{resolve=done})
  const pending=f.account.start();f.account.hide()
  resolve({status:'waiting',loginId:'late-session',svg:'<svg/>',expiresAt:Date.now()+180000})
  await pending
  assert.equal(f.get('accountQr').src,undefined)
  assert.equal(f.requests.some(request=>request.name==='cancel_provider_login'&&request.args.loginId==='late-session'),true)
  const expired=fixture();await expired.account.show('bilibili');await expired.account.start()
  expired.state.poll={status:'expired'};await expired.tick(2000)
  assert.match(expired.get('accountStatus').textContent,/已过期/)
  assert.equal(expired.get('accountQrArea').hidden,true)
  expired.account.hide()
})
