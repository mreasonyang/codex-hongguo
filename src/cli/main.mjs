import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { prepareRuntime, findExecutable, spawnSync } from '../runtime/executables.mjs'
import { inspectHooks } from '../server/setup.mjs'
import { ensureFfmpeg, removeManagedFfmpeg } from '../runtime/ffmpeg-runtime.mjs'
import { removeUserData } from '../runtime/uninstall-data.mjs'

export const marketplaceName = 'hongguo-local'
export const pluginId = 'codex-hongguo@' + marketplaceName
export const defaultSource = 'mreasonyang/codex-hongguo'
const canonicalSource = source => typeof source === 'string' ? source.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '') : source

export function codexRunner(command, env = process.env) {
  return args => {
    const result = spawnSync(command, [...args, '--json'], { env, encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    // Host diagnostics may contain credentials. Only return parsed protocol data and fixed errors.
    if (result.status !== 0) throw Error('Codex 步骤失败：' + args.slice(0, 3).join(' ') + '。请在 Codex 插件设置中检查状态后重试。')
    try { return JSON.parse(result.stdout) } catch { throw Error('Codex 返回了无法识别的结果，请更新 Codex 后重试。') }
  }
}

export function validateSource(source) {
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) return source
  if (existsSync(source)) return source
  throw Error('--marketplace 只接受 owner/repo 或现有本地市场目录。')
}

export function install({ run, source = defaultSource, update = false, dryRun = false, log = console.log }) {
  validateSource(source)
  if (dryRun) {
    log('将使用 Codex 原生市场安装 ' + pluginId + '；市场来源：' + source)
    log('观看进度保留在原数据目录。安装完成后需在 Codex 中审查并信任三个 Hooks。')
    return
  }
  const existing = run(['plugin', 'marketplace', 'list']).marketplaces?.find(row => row.name === marketplaceName)
  const previous = existing?.marketplaceSource?.source
  const replacing = !!existing && canonicalSource(previous) !== canonicalSource(source)
  // A stale ZIP marketplace uses the same ID. Keep one registration and restore it if migration fails.
  if (replacing) run(['plugin', 'marketplace', 'remove', marketplaceName])
  try {
    run(['plugin', 'marketplace', 'add', source])
    if (update && !replacing && existing?.marketplaceSource?.sourceType === 'git') run(['plugin', 'marketplace', 'upgrade', marketplaceName])
    run(['plugin', 'add', pluginId])
  } catch (error) {
    if (replacing && previous) {
      try {
        run(['plugin', 'marketplace', 'remove', marketplaceName])
      } catch { /* Registration may not have completed. */ }
      try {
        run(['plugin', 'marketplace', 'add', previous])
        run(['plugin', 'add', pluginId])
      } catch { throw Error('安装失败，原市场未能自动恢复。请从 Codex 插件设置重新添加原来源；观看进度仍保留。') }
    }
    throw error
  }
  log('红果短剧已安装。重新打开播放器即可使用新版。')
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const [action = 'help', ...options] = argv
    if (action === '--version') {
      console.log(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version)
      return
    }
    if (['help', '--help', '-h'].includes(action)) {
      console.log('红果短剧\n  codex-hongguo setup [--dry-run] [--marketplace owner/repo|目录]\n  codex-hongguo update [--dry-run] [--marketplace owner/repo|目录]\n  codex-hongguo uninstall [--dry-run]\n  codex-hongguo doctor\n需要 Node.js >=22.16 和 Codex CLI；播放组件由插件自动准备。')
      return
    }
    if (!['setup', 'update', 'uninstall', 'doctor'].includes(action)) throw Error('未知命令；运行 codex-hongguo --help 查看用法。')
    if (process.platform === 'win32' && process.arch !== 'x64') throw Error('Windows 试用版需要 x64 Node.js。')
    const [major, minor] = process.versions.node.split('.').map(Number)
    if (major < 22 || (major === 22 && minor < 16)) throw Error('需要 Node.js >=22.16。')
    prepareRuntime()
    if (action === 'doctor') {
      if (options.length) throw Error('doctor 不接受额外参数。')
      const checked = spawnSync(process.execPath, [fileURLToPath(new URL('../../dist/setup/check.mjs', import.meta.url))], { stdio: 'inherit', timeout: 15000 })
      if (checked.status !== 0) throw Error('环境检查未完成。')
      return
    }
    let source = defaultSource, dryRun = false
    for (let i = 0; i < options.length; i++) {
      if (options[i] === '--dry-run') dryRun = true
      else if (action !== 'uninstall' && options[i] === '--marketplace' && options[i + 1]) source = options[++i]
      else throw Error('无法识别命令参数；运行 codex-hongguo --help 查看用法。')
    }
    // Resolve everything before changing the host's marketplace registration.
    const codex = findExecutable('codex', process.env.HONGGUO_CODEX)
    const dependencies = [['Codex CLI', codex]]
    if (action !== 'uninstall') dependencies.push(['npm', findExecutable('npm')])
    for (const [name, command] of dependencies) {
      if (spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 3000 }).status !== 0)
        throw Error('未找到可运行的 ' + name + '。安装后重新运行 ' + action + '；已有插件与观看进度保持原样。')
    }
    if (action === 'uninstall') {
      if (dryRun) console.log('将卸载 ' + pluginId + '，删除播放组件、观看进度、设置、视频缓存和设备档案。')
      else {
        const run = codexRunner(codex)
        const installed = run(['plugin', 'list', '--marketplace', marketplaceName]).installed
        if (!Array.isArray(installed)) throw Error('无法确认插件安装状态，请更新 Codex 后重试。')
        if (installed.some(plugin => plugin.pluginId === pluginId)) run(['plugin', 'remove', pluginId])
        const failures = []
        for (const cleanup of [removeManagedFfmpeg, removeUserData]) {
          try { await cleanup() } catch (error) { failures.push(error.message) }
        }
        if (failures.length) throw Error(failures.join('\n'))
        console.log('红果短剧已卸载，播放组件、观看进度、设置、视频缓存和设备档案已删除。请打开新聊天。')
      }
      return
    }
    if (!dryRun) {
      console.log('正在准备播放组件，首次使用需要联网下载…')
      await ensureFfmpeg()
    }
    install({ run: codexRunner(codex), source, update: action === 'update', dryRun })
    if (!dryRun) {
      console.log('回合联动需要手动授权：打开 Codex 设置 → Hooks → 红果短剧，审查、信任并启用 UserPromptSubmit、Stop、Interrupt。')
      const hooks = await inspectHooks({ command: codex, installedId: pluginId })
      const names = { userPromptSubmit: 'UserPromptSubmit', stop: 'Stop', interrupt: 'Interrupt' }
      const pending = hooks.events.filter(row => row.status !== 'ready').map(row => names[row.event])
      if (hooks.status === 'ready') console.log('三个回合 Hooks 均已信任并启用，无需重复授权。')
      else if (hooks.status === 'unknown') console.log('暂未确认 Hooks 授权状态。请按上方步骤核对，再从播放器「设置 → 使用指南」重新检查。')
      else console.log('还需完成 ' + pending.join('、') + ' 的信任或启用。完成后从播放器「设置 → 使用指南」重新检查。')
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
