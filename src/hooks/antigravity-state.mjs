import { randomBytes } from 'node:crypto'
import { validId } from '../server/store.mjs'

// Plugin discovery is shared with Antigravity CLI and IDE. The documented
// transcript location distinguishes the App without opening any transcript.
export function isAntigravityApp(input) {
  return validId(input?.conversationId) && typeof input.transcriptPath === 'string' &&
    input.transcriptPath.replaceAll('\\', '/').endsWith('/antigravity/brain/' + input.conversationId + '/.system_generated/logs/transcript.jsonl')
}

// Antigravity does not expose a user-turn ID in hook payloads. Retain only
// counters and an opaque per-run ID; never store prompts or transcript contents.
export function recordAntigravityEvent(store, kind, input) {
  if (!input || !validId(input.conversationId) || input.conversationId.length > 120) return null
  const sessionId = 'agy_' + input.conversationId
  store.db.exec(`CREATE TABLE IF NOT EXISTS antigravity_runs (
    session_id TEXT PRIMARY KEY, start_step INTEGER NOT NULL, turn_id TEXT NOT NULL)`)
  return store.transaction(() => {
    const previous = store.db.prepare('SELECT * FROM antigravity_runs WHERE session_id=?').get(sessionId)
    if (kind === 'start') {
      const { invocationNum, initialNumSteps } = input
      if (!Number.isSafeInteger(invocationNum) || invocationNum < 0 ||
          !Number.isSafeInteger(initialNumSteps) || initialNumSteps < 0) return null
      // Tool/model iterations must never resume a manually paused video.
      if (invocationNum !== 0 || (previous && initialNumSteps <= previous.start_step)) return null
      // A background wakeup or another hook continuing the same execution is
      // still the same running turn. Stop(fullyIdle=false) deliberately keeps it.
      if (previous && store.activeTurn(sessionId, previous.turn_id)) return null
      const turnId = randomBytes(24).toString('base64url')
      store.db.prepare(`INSERT INTO antigravity_runs VALUES(?,?,?) ON CONFLICT(session_id)
        DO UPDATE SET start_step=excluded.start_step,turn_id=excluded.turn_id`).run(sessionId, initialNumSteps, turnId)
      store.event({ session_id: sessionId, turn_id: turnId, hook_event_name: 'UserPromptSubmit' })
      return { sessionId, turnId }
    }
    if (kind !== 'stop' || !previous) return null
    const cancelled = ['USER_CANCELED', 'USER_CANCELLED', 'user_canceled', 'user_cancelled'].includes(input.terminationReason)
    if (!cancelled && input.fullyIdle !== true) return null
    store.event({ session_id: sessionId, turn_id: previous.turn_id, hook_event_name: cancelled ? 'Interrupt' : 'Stop' })
    return null
  })
}
