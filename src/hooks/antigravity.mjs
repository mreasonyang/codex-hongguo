import { Store } from '../server/store.mjs'
import { isAntigravityApp, recordAntigravityEvent } from './antigravity-state.mjs'
import { antigravity } from '../runtime/host.mjs'

process.umask(0o077)
let store, output = {}
try {
  let bytes = 0
  const chunks = []
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 16 * 1024 * 1024) break
    chunks.push(chunk)
  }
  if (bytes <= 16 * 1024 * 1024) {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (isAntigravityApp(input)) store = new Store(undefined, false, { host: antigravity })
    const started = store && recordAntigravityEvent(store, process.argv[2], input)
    if (started && store.offerable(started.sessionId, started.turnId)) {
      output = { injectSteps: [{ systemMessage: { systemMessage:
        'The user enabled Hongguo waiting suggestions. Call show_waiting_picks from the codex-hongguo_hongguo MCP server once ' +
        'with turnId "' + started.turnId + '". If the tool is unavailable, continue without the widget. ' +
        'Continue the user task immediately. If presentation is sidecar or text and hasPicks is true, show the actual titles once in user-visible text. ' +
        'For sidecar, include the returned playerLink verbatim as a Markdown link. For text, show just the titles. ' +
        'Use a visible progress message if available, otherwise add one short line after the answer. ' +
        'Respect requests for silence or a strict response format. Do not ask for a choice or repeat the suggestions.',
      } }] }
    }
  }
} catch {
  // A failed entertainment hook must not block or continue the user's task.
} finally {
  store?.close()
  process.stdout.write(JSON.stringify(output) + '\n')
}
