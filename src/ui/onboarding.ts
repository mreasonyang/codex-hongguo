import { browser, call } from './api'
import { tr } from './locale'
import { icon } from './ui-kit'

type Setup = {
  runtime: string
  database: boolean
  ffmpeg: boolean
  dismissed: boolean
  hooks: { status: string; events: Array<{ event: string; status: string }> }
}
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
let generation = 0

function render(data: Setup) {
  const ready = data.hooks.status === 'ready'
  const needsReview = data.hooks.events.some(row => row.status === 'needs_review')
  el('setupTitle').textContent = tr(needsReview ? '请审查红果的回合 Hooks' : '开始使用红果')
  const rows: Array<[string, string, boolean]> = [
    ['Node', data.runtime, true],
    ['进度库', data.database ? '可写' : '不可用', data.database],
    ['FFmpeg', data.ffmpeg ? '就绪' : '缺失', data.ffmpeg],
    ['回合联动', ready ? '已配置' : data.hooks.status === 'unknown' ? '待确认' : '待配置', ready],
  ]
  el('setupRows').replaceChildren(...rows.map(([name, value, ok]) => {
    const row = document.createElement('div'), label = document.createElement('span'), result = document.createElement('span')
    row.className = 'healthRow ' + (ok ? 'ok' : 'bad')
    label.textContent = tr(name)
    result.textContent = tr(value)
    row.append(icon(ok ? 'check' : 'alert'), label, result)
    return row
  }))
  const help = !data.database ? '进度暂时无法保存，请检查红果的数据目录权限。'
    : !data.ffmpeg ? '尚未找到 FFmpeg。安装后重启 Codex，再从「设置 → 使用指南」重新检查。'
    : ready ? '回合联动已就绪。可在设置中配置任务开始自动播放和任务结束自动暂停。'
    : data.hooks.status === 'unknown' ? '暂时无法读取 Hooks 状态，请在宿主设置中核对。现在可以先手动观看。'
    : data.hooks.events.some(event => event.status === 'missing') ? '尚未发现完整的回合事件。请检查插件已启用，并在新的本地对话中重试。'
    : '回合联动尚未配置。完成下方操作后重新检查，也可以先手动观看。'
  el('setupHelp').textContent = tr(help)
  el('setupGuide').querySelector<HTMLElement>('.setupHooks')!.hidden = ready
}

export async function showSetup(force = true) {
  if (browser) return
  const ticket = ++generation
  const check = el<HTMLButtonElement>('setupCheck')
  check.disabled = true
  if (force) {
    el('setupGuide').hidden = false
    el('setupRows').replaceChildren()
    el('setupHelp').textContent = tr('正在检查…')
  }
  try {
    const data = await call<Setup>('get_setup_status')
    if (ticket !== generation) return
    render(data)
    const needsAttention = !data.database || !data.ffmpeg || data.hooks.status === 'needs_attention'
    el('setupGuide').hidden = !(force || needsAttention)
  } catch {
    if (ticket !== generation) return
    el('setupGuide').hidden = !force
    el('setupRows').replaceChildren()
    el('setupHelp').textContent = tr('检查未完成，请稍后重试或在 Codex 设置 → Hooks 核对回合联动。')
    el('setupGuide').querySelector<HTMLElement>('.setupHooks')!.hidden = false
  } finally {
    if (ticket === generation) check.disabled = false
  }
}

export function initOnboarding(notify: (message: string) => void) {
  el('setupOpen').hidden = browser
  el('setupCheck').onclick = () => void showSetup()
  el('setupDone').onclick = async () => {
    ++generation
    const done = el<HTMLButtonElement>('setupDone')
    done.disabled = true
    try { await call('set_setup_dismissed', { dismissed: true }) }
    catch { notify('本次已收起指南，暂时无法保存此设置。') }
    finally {
      el('setupGuide').hidden = true
      done.disabled = false
      el<HTMLButtonElement>('setupCheck').disabled = false
    }
  }
  void showSetup(false)
}
