import { cp, mkdir, mkdtemp, readFile, writeFile, rename, rm, lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { projectRoot } from '../server/paths.mjs'
import { antigravityHookHint } from '../server/setup.mjs'
import { ensureFfmpeg, registerFfmpegHost, removeManagedFfmpeg } from '../runtime/ffmpeg-runtime.mjs'
import { removeUserData } from '../runtime/uninstall-data.mjs'
import { antigravity } from '../runtime/host.mjs'
import { installSharedProgram, removeSharedProgram } from '../runtime/shared-program.mjs'
import { writeProgramShim } from './program-shim.mjs'
import { lockAntigravityInstall } from './antigravity-lock.mjs'

const owner = '@kyun.si/codex-hongguo'
const marker = '.hongguo-antigravity.json'
const readJson = async path => JSON.parse(await readFile(path, 'utf8'))
const writeJson = (path, value) => writeFile(path, JSON.stringify(value, null, 2) + '\n')
const exists = async path => { try { return await lstat(path) } catch (e) { if (e.code === 'ENOENT') return null; throw e } }

export function quoteCommand(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'"
}
async function writeAdapter(root, programHome, programRoot, node) {
  for (const name of ['.antigravity-plugin', 'skills']) {
    await cp(join(programRoot, name), join(root, name), { recursive: true })
  }
  const manifest = await readJson(join(root, '.antigravity-plugin/plugin.json'))
  if (manifest.logo === 'assets/logo.png') {
    await mkdir(join(root, 'assets'), { recursive: true })
    await cp(join(programRoot, manifest.logo), join(root, manifest.logo))
  }
  await mkdir(join(root, 'docs'), { recursive: true })
  await cp(join(programRoot, 'docs/providers.md'), join(root, 'docs/providers.md'))
  const hook = 'dist/hooks/antigravity.mjs'
  for (const entry of ['dist/server/antigravity.mjs', hook, 'bin/codex-hongguo.mjs']) {
    await writeProgramShim(join(root, entry), programHome, entry.startsWith('bin/') ? 'bin/antigravity-hongguo.mjs' : entry)
  }

  const mcp = await readJson(join(programRoot, 'mcp_config.json'))
  mcp.mcpServers.hongguo.command = node
  await writeJson(join(root, 'mcp_config.json'), mcp)
  const hooks = await readJson(join(programRoot, 'hooks.json'))
  for (const [event, mode] of [['PreInvocation', 'start'], ['Stop', 'stop']]) {
    const handler = hooks.hongguo[event][0]
    if (process.platform === 'win32') {
      // Keep the Node path out of cmd.exe's parser and pass the native stdio
      // handles directly to Node so PowerShell cannot re-encode Hook JSON.
      const script = [
        "$ErrorActionPreference = 'Stop'",
        '$launch = [Diagnostics.ProcessStartInfo]::new()',
        "$launch.FileName = (ConvertFrom-Json -InputObject ([IO.File]::ReadAllText('mcp_config.json'))).mcpServers.hongguo.command",
        "$launch.Arguments = './" + hook + " " + mode + "'",
        '$launch.UseShellExecute = $false',
        '$child = [Diagnostics.Process]::Start($launch)',
        '$child.WaitForExit()',
        'exit $child.ExitCode',
      ].join('; ')
      handler.command = 'powershell.exe -NoLogo -NoProfile -NonInteractive -Command "' + script + '"'
      handler.timeout = 10
    } else {
      handler.command = quoteCommand(node) + ' ./' + hook + ' ' + mode
    }
  }
  await writeJson(join(root, 'hooks.json'), hooks)
  await writeJson(join(root, marker), { owner, host: antigravity.id })
}
async function assertOwned(path) {
  const info = await exists(path)
  if (!info) return false
  if (!info.isDirectory() || info.isSymbolicLink()) throw Error('Antigravity 插件目录不是普通目录，已停止操作。')
  const receipt = await readJson(join(path, marker)).catch(() => null)
  if (receipt?.owner !== owner) throw Error('Antigravity 中已有非本安装器管理的 codex-hongguo，请先移走该目录。')
  return true
}
export function antigravityInstalled({ home = homedir(), configRoot = join(home, '.gemini', 'config') } = {}) {
  return assertOwned(join(configRoot, 'plugins', 'codex-hongguo'))
}
export async function manageAntigravity(action, {
  sourceRoot = projectRoot, home = homedir(), env = process.env, configRoot = join(home, '.gemini', 'config'), node = process.execPath,
  dryRun = false, log = console.log, prepare = ensureFfmpeg, register = registerFfmpegHost,
  removeData = removeUserData, removeFfmpeg = removeManagedFfmpeg,
} = {}) {
  if (!['setup', 'update', 'uninstall'].includes(action)) throw Error('未知 Antigravity 安装操作')
  const hostOptions = { host: antigravity, home, env }
  configRoot = resolve(configRoot)
  const destination = join(configRoot, 'plugins', 'codex-hongguo')
  if (dryRun) {
    log(action === 'uninstall' ? '将移除 Antigravity 红果插件和观看数据。最后一个宿主卸载时清理共享程序和 FFmpeg。'
      : '将安装红果短剧到 ' + destination + '；保留 Antigravity 观看进度。')
    return
  }
  await mkdir(configRoot, { recursive: true })
  const releaseLock = lockAntigravityInstall(configRoot)
  let staging, preserveBackup = false
  try {
    const installed = await assertOwned(destination)
    if (action === 'uninstall') {
      // Only clean data after the installed files have actually been removed.
      await removeSharedProgram(hostOptions, async () => {
        if (installed) await rm(destination, { recursive: true })
      })
      const failures = []
      for (const cleanup of [removeFfmpeg, removeData]) {
        try { await cleanup(hostOptions) } catch (e) { failures.push(e.message) }
      }
      if (failures.length) throw Error(failures.join('\n'))
      log('Antigravity 红果短剧及观看数据已移除。其他宿主仍在使用的共享程序和 FFmpeg 会保留。')
      return
    }
    if (!await exists(join(sourceRoot, 'dist', 'server', 'antigravity.mjs')))
      throw Error('缺少构建产物，请从 npm 发行包安装，或先运行 npm run build。')
    await prepare(hostOptions)
    // Stage outside plugins/ so the host never discovers a half-written adapter.
    staging = await mkdtemp(join(configRoot, '.hongguo-stage-'))
    const candidate = join(staging, 'plugin'), backup = join(staging, 'previous')
    let published = false, backedUp = false
    try {
      await installSharedProgram({ ...hostOptions, sourceRoot }, async ({ programHome, programRoot }) => {
        await mkdir(candidate)
        await writeAdapter(candidate, programHome, programRoot, node)
        await mkdir(join(configRoot, 'plugins'), { recursive: true })
        if (installed) {
          await rename(destination, backup)
          backedUp = true
        }
        await rename(candidate, destination)
        published = true
        await register(hostOptions)
      })
    } catch (error) {
      try {
        if (published) await rename(destination, candidate)
        if (backedUp) await rename(backup, destination)
      } catch {
        preserveBackup = backedUp
        throw Error(backedUp ? '安装未完成，原插件副本保留在 ' + backup + '。请关闭 Antigravity 后恢复该目录。'
          : '安装未完成。请关闭 Antigravity 后重新运行 setup。')
      }
      throw error
    }
    log('红果短剧已安装到 Antigravity。请关闭旧播放器，在 MCP Servers 中重启 hongguo 服务后使用。')
    log(antigravityHookHint)
  } finally {
    try {
      if (staging && !preserveBackup) await rm(staging, { recursive: true, force: true })
    } finally { releaseLock() }
  }
}
