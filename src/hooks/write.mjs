import { Store } from '../server/store.mjs'

process.umask(0o077)
let store
let output = {}
try {
  let bytes = 0
  const chunks = []
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 16 * 1024 * 1024) break
    chunks.push(chunk)
  }
  if (bytes <= 16 * 1024 * 1024) {
    const { session_id, turn_id, hook_event_name } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    store = new Store()
    const changed = store.event({ session_id, turn_id, hook_event_name })
    if (changed && hook_event_name === 'UserPromptSubmit' && store.offerable(session_id, turn_id)) {
      output = { hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: 'The user has enabled Hongguo waiting suggestions. At the start of this turn, ' +
          'call the Hongguo plugin tool show_waiting_picks once with turnId "' + turn_id +
          '". If tools are deferred, look it up by name. Continue the user’s task immediately. ' +
          'The optional widget loads independently. Do not ask for a choice or mention the widget in your reply.',
      } }
    }
  }
} catch {
  // Hooks fail open. Never echo the payload or send a continuation decision.
} finally {
  store?.close()
  process.stdout.write(JSON.stringify(output) + '\n')
}
