import { codex } from '../runtime/host.mjs'
export const hookAuthorizationHint = '请在 Codex 设置 → Hooks → 红果短剧中检查授权，审查、信任并启用 UserPromptSubmit、Stop、Interrupt。'
export const antigravityHookHint = '请在 Antigravity 设置 → Customizations → Hooks 中审查并启用红果短剧的 PreInvocation、Stop。'

export function manualHooks(host = codex) {
  if (host.id === 'antigravity') return { status: 'manual_check', events: ['PreInvocation', 'Stop'].map(event => ({ event, status: 'manual_check' })), message: antigravityHookHint }
  return {
    status: 'manual_check',
    events: ['userPromptSubmit', 'stop', 'interrupt'].map(event => ({ event, status: 'manual_check' })),
    message: hookAuthorizationHint,
  }
}
