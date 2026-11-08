import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { prepareRuntime, findExecutable, spawnSync } from '../runtime/executables.mjs'
import { hookAuthorizationHint } from '../server/setup.mjs'
import { ensureFfmpeg, removeManagedFfmpeg, ffmpegPreparationTimeoutMs } from '../runtime/ffmpeg-runtime.mjs'
import { removeUserData } from '../runtime/uninstall-data.mjs'
import { assertWindowsPluginIdle } from '../runtime/windows-processes.mjs'
import { marketplaceName } from '../runtime/distribution.mjs'
import { defaultSource, prepareLocalMarketplace, isManagedMarketplace, marketplaceSource } from './local-marketplace.mjs'

export { marketplaceName, defaultSource }
export const pluginId = 'codex-hongguo@' + marketplaceName
const canonicalSource = source => typeof source === 'string' ? source.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').replace(/\/$/, '') : source

export function codexRunner(command, env = process.env) {
  return args => {
    const result = spawnSync(command, [...args, '--json'], { env, encoding: 'utf8', timeout: 120000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 })
    // Host diagnostics may contain credentials. Only return parsed protocol data and fixed errors.
    if (result.status !== 0) {
      if (args[0] === 'plugin' && args[1] === 'remove') {
        const occupied = /os error 5|access is denied|permission denied|拒绝访问|EBUSY|EPERM|being used by another process/i.test((result.stderr || '') + '\n' + (result.stdout || ''))
        const error = Error(occupied
          ? '无法删除红果插件缓存：文件仍被占用或权限不足。请关闭红果播放器及使用该插件的 Codex 会话，再重新运行 uninstall；尚未清理观看数据。'
          : '红果插件卸载失败，尚未清理观看数据。请关闭红果播放器及使用该插件的 Codex 会话，检查缓存目录权限后重试。')
        error.code = occupied ? 'PLUGIN_CACHE_IN_USE' : 'PLUGIN_REMOVE_FAILED'
        throw error
      }
      const text = (result.stderr || '') + '\n' + (result.stdout || '')
      const reason = /no such file|does not exist|cannot find|not found/i.test(text) ? 'not_found' : /access is denied|os error 5|permission denied/i.test(text) ? 'access_denied' : /git/i.test(text) ? 'git' : 'unknown'
      throw Object.assign(Error('Codex 步骤失败：' + args.slice(0, 3).join(' ') + '。请在 Codex 插件设置中检查状态后重试。'), { diagnostic: { step: args.slice(0, 3).join(' '), reason, status: result.status } })
    }
    try { return JSON.parse(result.stdout) } catch { throw Error('Codex 返回了无法识别的结果，请更新 Codex 后重试。') }
  }
}

export async function uninstall({ run, assertIdle = assertWindowsPluginIdle, removeFfmpeg = removeManagedFfmpeg, removeData = removeUserData, managedRoot }) {
  await assertIdle()
  const registrations = run(['plugin', 'marketplace', 'list']).marketplaces
  if (!Array.isArray(registrations)) throw Error('无法确认插件市场状态，请更新 Codex 后重试。')
  const registered = registrations.find(row => row.name === marketplaceName)
  const source = marketplaceSource(registered)
  if (registered && (typeof source !== 'string' || !source.length)) throw Error('无法确认红果市场的位置，尚未清理数据。请更新 Codex CLI 后重新运行 uninstall。')
  const installed = run(['plugin', 'list', '--marketplace', marketplaceName]).installed
  if (!Array.isArray(installed)) throw Error('无法确认插件安装状态，请更新 Codex 后重试。')
  if (installed.some(plugin => plugin.pluginId === pluginId)) run(['plugin', 'remove', pluginId])
  if (registered && isManagedMarketplace(source, managedRoot)) {
    run(['plugin', 'marketplace', 'remove', marketplaceName])
    const remaining = run(['plugin', 'marketplace', 'list']).marketplaces
    if (!Array.isArray(remaining) || remaining.some(row => row.name === marketplaceName))
      throw Error('红果市场尚未注销，已保留本地数据。请重新运行 uninstall。')
  }
  const failures = []
  for (const cleanup of [removeFfmpeg, removeData]) {
    try { await cleanup() } catch (error) { failures.push(error.message) }
  }
  if (failures.length) throw Error(failures.join('\n'))
}

export function validateSource(source) {
  if (/^[\w.-]+\/[\w.-]+$/.test(source)) return source
  if (existsSync(source)) return source
  throw Error('--marketplace 只接受 owner/repo 或现有本地市场目录。')
}

export function install({ run, source = defaultSource, dryRun = false, log = console.log }) {
  if (!dryRun || source !== defaultSource) validateSource(source)
  if (dryRun) {
    log('将使用 Codex 原生市场安装 ' + pluginId + '；市场来源：' + source)
    log('观看进度保留在原数据目录。安装完成后需在 Codex 中审查并信任三个 Hooks。')
    return
  }
  const existing = run(['plugin', 'marketplace', 'list']).marketplaces?.find(row => row.name === marketplaceName)
  const previous = marketplaceSource(existing)
  const replacing = !!existing && canonicalSource(previous) !== canonicalSource(source)
  // Migrate Git/ZIP/older managed indexes under one ID, retaining the old source
  // until the new plugin installs so rollback never clears viewing progress.
  if (replacing) run(['plugin', 'marketplace', 'remove', marketplaceName])
  try {
    run(['plugin', 'marketplace', 'add', source])
    if (source !== defaultSource && !replacing && existing?.marketplaceSource?.sourceType === 'git') run(['plugin', 'marketplace', 'upgrade', marketplaceName])
    run(['plugin', 'add', pluginId])
  } catch (error) {
    // A failed migration must not reintroduce the Git dependency we are removing.
    if (source === defaultSource && existing?.marketplaceSource?.sourceType === 'git')
      throw Error('本机 npm 市场安装未完成，请重新运行 setup；观看进度仍保留。')
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
  log('红果短剧已安装。请在新的本地聊天中使用；更新时先关闭旧播放器。')
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
    if (process.platform === 'win32' && !['x64', 'arm64'].includes(process.arch)) throw Error('Windows 需要 x64 或 ARM64 Node.js，请安装对应的 64 位版本后重试。')
    const [major, minor] = process.versions.node.split('.').map(Number)
    if (major < 22 || (major === 22 && minor < 16)) throw Error('需要 Node.js >=22.16。')
    prepareRuntime()
    if (action === 'doctor') {
      if (options.length) throw Error('doctor 不接受额外参数。')
      const checked = spawnSync(process.execPath, [fileURLToPath(new URL('../../dist/setup/check.mjs', import.meta.url))], { stdio: 'inherit', timeout: ffmpegPreparationTimeoutMs })
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
      const checked = spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 15000, windowsHide: true })
      if (checked.status === 0) continue
      if (checked.error?.code === 'ETIMEDOUT') throw Error(name + ' 启动超时，请单独运行它的 --version 命令后重试；观看进度保持原样。')
      if (checked.error?.code === 'ENOENT') throw Error('未找到 ' + name + '。请检查安装位置和 PATH 后重新运行 ' + action + '。')
      throw Error(name + ' 已找到但启动失败，请单独运行它的 --version 命令查看错误后重试；观看进度保持原样。')
    }
    if (action === 'uninstall') {
      if (dryRun) console.log('将卸载 ' + pluginId + '，删除播放组件、观看进度、设置、视频缓存和设备档案。')
      else {
        const run = codexRunner(codex)
        await uninstall({ run })
        console.log('红果短剧已卸载，播放组件、观看进度、设置、视频缓存和设备档案已删除。请打开新聊天。')
      }
      return
    }
    if (!dryRun) {
      if (source === defaultSource) await prepareLocalMarketplace()
      console.log('正在准备播放组件，首次使用需要联网下载（下载总时限30分钟）…')
      await ensureFfmpeg()
    }
    install({ run: codexRunner(codex), source, dryRun })
    if (!dryRun) console.log(hookAuthorizationHint)
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
