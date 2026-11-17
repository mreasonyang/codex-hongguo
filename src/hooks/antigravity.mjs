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
        'The user enabled Hongguo waiting suggestions. Call the Hongguo plugin tool show_waiting_picks once ' +
        'with turnId "' + started.turnId + '". Look it up by name if deferred. ' +
        'Continue the user task immediately; the optional widget loads independently. Do not ask for a choice or mention it in your reply.',
      } }] }
    }
  }
} catch {
  // A failed entertainment hook must not block or continue the user's task.
} finally {
  store?.close()
  process.stdout.write(JSON.stringify(output) + '\n')
}
