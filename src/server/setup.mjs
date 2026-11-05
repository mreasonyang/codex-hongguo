import { realpathSync } from 'node:fs'
import { relative, resolve as resolvePath, isAbsolute } from 'node:path'
import { projectRoot } from './paths.mjs'
import { findExecutable, spawn, stopChild } from '../runtime/executables.mjs'

const events = ['userPromptSubmit', 'stop', 'interrupt']
export const unknownHooks = () => ({ status: 'unknown', events: events.map(event => ({ event, status: 'unknown' })) })

/** Ask the public host API about this plugin only. Never expose raw hook commands or host diagnostics. */
export function inspectHooks({ command = findExecutable('codex', process.env.HONGGUO_CODEX), args = ['app-server'], cwd = process.cwd(), timeoutMs = 8000, pluginRoot = projectRoot, installedId } = {}) {
  const canonical = path => { try { return realpathSync(path) } catch { return resolvePath(path) } }
  const root = canonical(pluginRoot)
  return new Promise(resolve => {
    let child, finished = false, buffer = '', bytes = 0
    const finish = value => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      stopChild(child)
      resolve(value)
    }
    const timer = setTimeout(() => finish(unknownHooks()), timeoutMs)
    try {
      child = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      child.on('error', () => finish(unknownHooks()))
      child.on('exit', () => finish(unknownHooks()))
      child.stdin.on('error', () => finish(unknownHooks()))
      child.stdout.setEncoding('utf8')
      const send = message => child.stdin.write(JSON.stringify(message) + '\n')
      child.stdout.on('data', chunk => {
        if (finished) return
        bytes += Buffer.byteLength(chunk)
        if (bytes > 2 * 1024 * 1024) return finish(unknownHooks())
        buffer += chunk
        let end
        while (!finished && (end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          let message
          try { message = JSON.parse(line) } catch { continue }
          if (message.error && [1, 2].includes(message.id)) return finish(unknownHooks())
          if (message.id === 1 && message.result) {
            send({ jsonrpc: '2.0', method: 'initialized' })
            send({ jsonrpc: '2.0', id: 2, method: 'hooks/list', params: { cwds: [cwd] } })
          }
          if (message.id === 2 && Array.isArray(message.result?.data)) {
            const hooks = message.result.data.flatMap(row => Array.isArray(row?.hooks) ? row.hooks : [])
              .filter(hook => typeof hook?.pluginId === 'string' && hook.pluginId.split('@')[0] === 'codex-hongguo')
              .filter(hook => {
                if (typeof hook.sourcePath !== 'string') return false
                // The updating CLI can be running from npx or an extracted archive.
                if (installedId) return hook.pluginId === installedId
                const path = relative(root, canonical(hook.sourcePath))
                return path && !path.startsWith('..') && !isAbsolute(path)
              })
            // The MCP process may not inherit a host's custom configuration root.
            // Absence cannot establish the state of this installed copy.
            if (!hooks.length) return finish(unknownHooks())
            const result = events.map(event => {
              const matches = hooks.filter(hook => hook.eventName === event)
              const status = !matches.length ? 'missing'
                : matches.some(hook => !hook.enabled) ? 'disabled'
                : matches.every(hook => ['trusted', 'managed'].includes(hook.trustStatus)) ? 'ready'
                : matches.some(hook => ['untrusted', 'modified'].includes(hook.trustStatus)) ? 'needs_review'
                : 'unknown'
              return { event, status }
            })
            finish({ status: result.every(row => row.status === 'ready') ? 'ready' : 'needs_attention', events: result })
          }
        }
      })
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
        clientInfo: { name: 'hongguo-setup', version: '1' }, capabilities: { experimentalApi: true },
      } })
    } catch { finish(unknownHooks()) }
  })
}
