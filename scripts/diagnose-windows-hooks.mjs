// Read-only Windows diagnostics. Never execute hooks or print host logs/configuration.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { findExecutable, spawn, spawnSync, stopChild } from '../src/runtime/executables.mjs'
import { isVersion } from '../src/runtime/version.mjs'

const pluginId = 'codex-hongguo@hongguo-local'
const expectedEvents = ['UserPromptSubmit', 'Stop', 'Interrupt']
const timeout = 20000
const jsonFile = path => {
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
const failure = result => result.error?.code === 'ETIMEDOUT' ? 'timeout' : result.error?.code === 'ENOENT' ? 'not_found' : 'failed'
function commandJson(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })
  if (result.status !== 0) return { error: failure(result) }
  try { return { value: JSON.parse(result.stdout) } } catch { return { error: 'invalid_json' } }
}
function engineVersion(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  return result.status === 0 ? result.stdout.match(/codex-cli\s+(\d+\.\d+\.\d+(?:[-.][\w.]+)?)/)?.[1] ?? 'unknown' : failure(result)
}
function installedState(command) {
  const result = commandJson(command, ['plugin', 'list', '--marketplace', 'hongguo-local', '--json'])
  if (result.error) return { error: result.error }
  const row = result.value?.installed?.find(p => p.pluginId === pluginId)
  return row ? { installed: true, enabled: row.enabled === true, version: isVersion(row.version) ? row.version : 'unknown' } : { installed: false }
}
function hookFeature(command) {
  const result = spawnSync(command, ['features', 'list'], { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
  if (result.status !== 0) return 'unknown'
  const match = result.stdout.match(/^hooks\s+\S+\s+(true|false)\s*$/m)
  return match ? match[1] === 'true' : 'unknown'
}
function cachedFiles(codexHome) {
  const cache = join(codexHome, 'plugins', 'cache', 'hongguo-local', 'codex-hongguo')
  if (!existsSync(cache)) return { cachePresent: false, copies: [] }
  let entries
  try { entries = readdirSync(cache, { withFileTypes: true }) } catch { return { cachePresent: true, error: 'unreadable', copies: [] } }
  const copies = entries.filter(e => e.isDirectory() && !e.isSymbolicLink()).slice(0, 30).map(entry => {
    const root = join(cache, entry.name)
    const portable = jsonFile(join(root, 'plugin.json'))
    const compatibility = jsonFile(join(root, '.codex-plugin', 'plugin.json'))
    const hooks = jsonFile(join(root, 'hooks', 'hooks.json'))
    const manifest = portable ?? compatibility
    return {
      version: isVersion(manifest?.version) ? manifest.version : 'unknown',
      portableManifestPresent: existsSync(join(root, 'plugin.json')),
      compatibilityManifestPresent: existsSync(join(root, '.codex-plugin', 'plugin.json')),
      expectedCompatibilityHookPath: compatibility?.hooks === './hooks/hooks.json',
      hooksFilePresent: existsSync(join(root, 'hooks', 'hooks.json')),
      hooksFileParsed: hooks !== null,
      events: expectedEvents.filter(event => Array.isArray(hooks?.hooks?.[event]) && hooks.hooks[event].length > 0),
      windowsOverrides: expectedEvents.filter(event => hooks?.hooks?.[event]?.some(group => group.hooks?.some(handler => typeof handler.commandWindows === 'string' && handler.commandWindows.trim()))),
      x64LauncherPresent: existsSync(join(root, 'bin', 'run-node.exe')),
      arm64LauncherPresent: existsSync(join(root, 'bin', 'run-node-arm64.exe')),
    }
  })
  return { cachePresent: true, copies }
}
function desktopEngines() {
  const powershell = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const script = "$ErrorActionPreference='Stop'; @((Get-AppxPackage -Name '*ChatGPT*'),(Get-AppxPackage -Name '*Codex*')) | Where-Object { $_ } | Select-Object Name,Version,InstallLocation | ConvertTo-Json -Compress"
  const packages = commandJson(powershell, ['-NoProfile', '-NonInteractive', '-Command', script])
  const rows = packages.value ? (Array.isArray(packages.value) ? packages.value.flat() : [packages.value]) : []
  const roots = rows.flatMap(row => typeof row.InstallLocation === 'string' ? [row.InstallLocation, join(row.InstallLocation, 'app')] : [])
  if (process.env.LOCALAPPDATA) for (const app of ['ChatGPT', 'Codex']) roots.push(join(process.env.LOCALAPPDATA, 'Programs', app))
  const paths = roots.flatMap(root => [
    join(root, 'resources', 'codex.exe'),
    join(root, 'resources', 'codex-cli', 'bin', 'codex.exe'),
    join(root, 'resources', 'codex-cli', 'codex.exe'),
    join(root, 'codex.exe'),
  ])
  return { packageQuery: packages.error ?? 'ok', commands: [...new Set(paths.filter(existsSync))] }
}
async function discover(command) {
  let child
  let reader
  let requestId = 0
  const pending = new Map()
  const rejectPending = () => {
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(Error('host_unavailable')) }
    pending.clear()
  }
  try {
    // Use a neutral cwd, so discovery reports user/plugin sources without project hooks.
    const cwd = tmpdir()
    child = spawn(command, ['app-server'], { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    child.on('error', rejectPending)
    child.on('close', rejectPending)
    child.stdin.on('error', rejectPending)
    child.stdout.on('error', rejectPending)
    reader = createInterface({ input: child.stdout })
    reader.on('line', line => {
      if (line.length > 4 * 1024 * 1024) return
      let response
      try { response = JSON.parse(line) } catch { return }
      const request = pending.get(response.id)
      if (!request) return
      pending.delete(response.id)
      clearTimeout(request.timer)
      if (response.error) request.reject(Error('request_failed'))
      else request.resolve(response.result)
    })
    const rpc = (method, params) => new Promise((resolve, reject) => {
      const id = ++requestId
      const timer = setTimeout(() => { pending.delete(id); reject(Error('timeout')) }, timeout)
      pending.set(id, { resolve, reject, timer })
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
    await rpc('initialize', { clientInfo: { name: 'hongguo-windows-hooks-diagnostic', version: '1' }, capabilities: { experimentalApi: true } })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'initialized' }) + '\n')
    const result = await rpc('hooks/list', { cwds: [cwd] })
    const entries = Array.isArray(result?.data) ? result.data : []
    const hooks = entries.flatMap(entry => entry.hooks ?? [])
    const own = hooks.filter(hook => hook.pluginId === pluginId)
    const issues = entries.flatMap(entry => [...(entry.errors ?? []), ...(entry.warnings ?? [])]).map(issue => typeof issue === 'string' ? issue : issue.message ?? '')
    const report = {
      discoveryResponse: 'ok',
      entryCount: entries.length,
      totalHookCount: hooks.length,
      hongguoEvents: own.map(hook => hook.eventName).filter(event => ['userPromptSubmit', 'stop', 'interrupt'].includes(event)),
      issueCount: issues.length,
      issueCategories: ['fingerprint', 'failed to parse', 'failed to read', 'unknown field', 'not installed', 'managed'].filter(term => issues.some(issue => issue.toLowerCase().includes(term))),
    }
    try {
      const policy = await rpc('configRequirements/read', {})
      const value = policy?.requirements?.allowManagedHooksOnly ?? policy?.requirements?.allow_managed_hooks_only
      report.allowManagedHooksOnly = typeof value === 'boolean' ? value : null
    } catch { report.policyQuery = 'unavailable' }
    return report
  } catch (error) {
    return { discoveryResponse: ['timeout', 'request_failed', 'host_unavailable'].includes(error.message) ? error.message : 'failed' }
  } finally {
    rejectPending()
    reader?.close()
    child?.stdin?.destroy()
    stopChild(child)
  }
}

async function main() {
  if (process.platform !== 'win32') throw Error('This diagnostic is for Windows only.')
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')
  const cli = findExecutable('codex', process.env.HONGGUO_CODEX)
  const desktop = desktopEngines()
  const commands = [{ kind: 'npm-or-path-cli', command: cli }, ...desktop.commands.slice(0, 2).map(command => ({ kind: 'desktop-bundled', command }))]
  const engines = []
  for (const { kind, command } of commands) {
    const version = engineVersion(command)
    engines.push({ kind, version, hooksFeatureEnabled: hookFeature(command), installation: installedState(command), ...await discover(command) })
  }
  console.log(JSON.stringify({ diagnosticVersion: 1, platform: process.platform, nodeArch: process.arch, customCodexHome: !!process.env.CODEX_HOME, cache: cachedFiles(codexHome), desktopPackageQuery: desktop.packageQuery, desktopEngineFound: desktop.commands.length > 0, engines }, null, 2))
}
main().catch(() => { console.error('Windows hook diagnostics could not complete. No configuration was changed.'); process.exitCode = 1 })
