import checkbox from '@inquirer/checkbox'
import { homedir } from 'node:os'
import { findExecutable, spawnSync } from '../runtime/executables.mjs'
import { codex, antigravity, hostProfile } from '../runtime/host.mjs'
import { marketplaceName } from '../runtime/distribution.mjs'
import { antigravityInstalled } from './antigravity.mjs'

const hosts = [codex, antigravity]
export const hostName = host => host.id === 'codex' ? 'Codex' : 'Antigravity'

export function parseHostArguments(argv) {
  const args = [], selected = new Map()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    let id
    if (arg === '--host') {
      id = argv[++i]
      if (!id || id.startsWith('-')) throw Error('--host 需要指定 codex 或 antigravity。')
    } else if (arg.startsWith('--host=')) id = arg.slice('--host='.length)
    else if (arg === '--codex') id = 'codex'
    else if (arg === '--agy' || arg === '--antigravity') id = 'antigravity'
    else {
      args.push(arg)
      // Marketplace paths and Provider arguments are values, not host switches.
      if (['--marketplace', '--id', '--query'].includes(arg) && i + 1 < argv.length) args.push(argv[++i])
      if (arg === '--') { args.push(...argv.slice(i + 1)); break }
      continue
    }
    const host = hostProfile(id)
    selected.set(host.id, host)
  }
  return { args, hosts: [...selected.values()] }
}

function codexInstalled({ env, home }) {
  const command = findExecutable('codex', env.HONGGUO_CODEX, { env, home })
  const result = spawnSync(command, ['plugin', 'list', '--marketplace', marketplaceName, '--json'], {
    env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000, windowsHide: true, maxBuffer: 1024 * 1024,
  })
  if (result.status !== 0) throw Error('无法确认 Codex 安装状态。')
  const { installed } = JSON.parse(result.stdout)
  if (!Array.isArray(installed)) throw Error('无法确认 Codex 安装状态。')
  return installed.some(plugin => plugin.pluginId === 'codex-hongguo@' + marketplaceName)
}

export async function hostInstallations({ env = process.env, home = homedir() } = {}) {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => codexInstalled({ env, home })),
    antigravityInstalled({ home }),
  ])
  return hosts.map((host, index) => ({ host, installed: results[index].status === 'fulfilled' ? results[index].value : null }))
}

export async function selectSetupHosts({ input = process.stdin, output = process.stdout, inspect = hostInstallations } = {}) {
  if (!input.isTTY || !output.isTTY)
    throw Error('setup 需要交互终端来选择应用；脚本中请使用 setup --codex、setup --agy 或 setup --codex --agy。')
  const installations = await inspect()
  const choices = installations.map(({ host, installed }) => {
    const status = installed === true ? '已安装，可重新安装' : installed === false ? '未安装' : '安装状态暂无法确认'
    return { value: host, name: `${hostName(host)}（${status}）`, short: hostName(host), checked: false }
  })
  const controller = new AbortController(), wasRaw = Boolean(input.isRaw)
  let inputFailure
  const cancel = () => controller.abort()
  const cancelKey = (value, key) => {
    if (key?.name === 'escape' || (key?.ctrl && key.name === 'd') || value === 'q') cancel()
  }
  const fail = error => { inputFailure = error; cancel() }
  input.once('end', cancel)
  input.once('close', cancel)
  input.once('error', fail)
  input.on('keypress', cancelKey)
  if (input.readableEnded || input.destroyed) cancel()
  try {
    return await checkbox({
      message: '选择要安装红果短剧的应用', choices, loop: true,
      validate: selected => selected.length > 0 || '请至少勾选一个应用。',
      shortcuts: { all: null, invert: null },
      theme: {
        icon: { checked: '[x]', unchecked: '[ ]', cursor: '❯' },
        style: {
          keysHelpTip: () => '↑↓ 移动  空格 勾选  回车 确认  Esc 取消',
          renderSelectedChoices: selected => selected.map(choice => choice.short).join('、'),
        },
      },
    }, { input, output, signal: controller.signal })
  } catch (error) {
    if (inputFailure) throw inputFailure
    if (error?.name === 'ExitPromptError' || (controller.signal.aborted && error?.name === 'AbortPromptError')) return []
    throw error
  } finally {
    input.removeListener('end', cancel)
    input.removeListener('close', cancel)
    input.removeListener('error', fail)
    input.removeListener('keypress', cancelKey)
    if (typeof input.setRawMode === 'function' && input.isRaw !== wasRaw) input.setRawMode(wasRaw)
  }
}

export async function configureSetupHosts(selected, configure, { error = console.error } = {}) {
  if (selected.length === 1) return configure(selected[0])
  const failed = []
  for (const host of selected) {
    try { await configure(host) } catch (failure) {
      error(hostName(host) + ' 安装未完成：' + failure.message)
      failed.push(hostName(host))
    }
  }
  if (failed.length) throw Error('以下应用安装未完成：' + failed.join('、') + '。其他已完成的安装会保留，请重试失败的应用。')
}
