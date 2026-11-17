// Entrypoints choose a fixed profile. App identity never comes from the
// process environment; shared code receives it explicitly.
export const codex = Object.freeze({ id: 'codex', dataName: 'CodexHongguo', cacheName: 'codex-hongguo' })
export const antigravity = Object.freeze({ id: 'antigravity', dataName: 'AntigravityHongguo', cacheName: 'antigravity-hongguo' })
export function hostProfile(id) {
  if (id === codex.id) return codex
  if (id === antigravity.id) return antigravity
  throw Error('未知 App；只接受 codex 或 antigravity。')
}
