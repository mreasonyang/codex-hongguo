import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { transformSync } from 'esbuild'

class Element {
  hidden = true; disabled = false; children = []; textContent = ''
  append(...children) { this.children.push(...children) }
  replaceChildren(...children) { this.children = children }
}
const source = readFileSync(new URL('../src/ui/onboarding.ts', import.meta.url), 'utf8')
const code = transformSync(source, { loader: 'ts', format: 'cjs' }).code
const instruction = readFileSync(new URL('../src/ui/player.html', import.meta.url), 'utf8').match(/<p class="setupHooks">([^<]+)<\/p>/)[1]
function fixture({ dismissed = false, status = 'unknown', fail = false } = {}) {
  const data = { runtime: 'v24', database: true, ffmpeg: true, dismissed,
    hooks: { status, events: ['userPromptSubmit','stop','interrupt'].map(event=>({event,status:status === 'ready' ? 'ready' : 'unknown'})) } }
  const elements = new Map(), instructions = new Element()
  instructions.hidden = false; instructions.textContent = instruction
  const document = {
    getElementById(id) { if (!elements.has(id)) elements.set(id,new Element()); return elements.get(id) },
    createElement() { return new Element() },
  }
  document.getElementById('setupGuide').querySelector = () => instructions
  const exports = {}, context = vm.createContext({ module:{exports},exports,document,
    require(name) {
      if (name === './api') return { browser:false, call:async name=>{
        if (name === 'get_setup_status') { if(fail) throw Error('unavailable'); return data }
        if (name === 'set_setup_dismissed') data.dismissed = true
      } }
      if (name === './locale') return {tr:value=>value}
      return {icon:()=>new Element()}
    },
  })
  vm.runInContext(code,context)
  return {api:context.module.exports,data,elements,instructions}
}

test('a first open shows trust instructions even when hook status is unknown', async()=>{
  const f=fixture(); await f.api.showSetup(false)
  assert.equal(f.elements.get('setupGuide').hidden,false)
  assert.equal(f.instructions.hidden,false)
  assert.match(f.instructions.textContent,/审查.*信任.*UserPromptSubmit.*Stop.*Interrupt/)
})
test('an unavailable setup check leaves the first-use trust instructions visible', async()=>{
  const f=fixture({fail:true}); await f.api.showSetup(false)
  assert.equal(f.elements.get('setupGuide').hidden,false)
  assert.equal(f.instructions.hidden,false)
  assert.match(f.elements.get('setupHelp').textContent,/Hooks/)
})
test('the first guide is shown even when playback and hooks are already ready', async()=>{
  const f=fixture({status:'ready'}); await f.api.showSetup(false)
  assert.equal(f.elements.get('setupGuide').hidden,false)
  assert.equal(f.instructions.hidden,true,'already trusted hooks need no second authorization')
})
test('a dismissed guide stays dismissed until opened explicitly or hooks need a new review', async()=>{
  const f=fixture({dismissed:true,status:'ready'}); await f.api.showSetup(false)
  assert.equal(f.elements.get('setupGuide').hidden,true)
  f.data.hooks.status='unknown'; await f.api.showSetup(false)
  assert.equal(f.elements.get('setupGuide').hidden,true)
  await f.api.showSetup(true)
  assert.equal(f.elements.get('setupGuide').hidden,false)
  f.data.hooks.status='needs_attention'; f.data.hooks.events.forEach(row=>row.status='needs_review')
  await f.api.showSetup(false)
  assert.equal(f.elements.get('setupGuide').hidden,false)
  assert.equal(f.instructions.hidden,false)
})
