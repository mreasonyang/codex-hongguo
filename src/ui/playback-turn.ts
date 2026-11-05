import type { State } from './api'

type Snapshot = Pick<State, 'state' | 'turnId'>

/** Only a new turn starts playback; mounting or polling the same turn does not. */
export function startedTurn(previous: Snapshot | null, next: Snapshot) {
  return !!previous && !!next.turnId && next.state === 'submitted' && previous.turnId !== next.turnId
}

/** Consume each chat turn's terminal transition once, independently of Play and Pause. */
export function finishedTurn(previous: Snapshot | null, next: Snapshot) {
  if (!previous || !next.turnId || (next.state !== 'stopped' && next.state !== 'interrupted')) return null
  if (previous.turnId === next.turnId && previous.state !== 'submitted') return null
  return next.state === 'interrupted' ? '本轮已中断，已为你暂停' : '本轮已停止，已为你暂停'
}
