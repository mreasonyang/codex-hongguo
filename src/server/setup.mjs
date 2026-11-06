export const hookAuthorizationHint = '请在 Codex 设置 → Hooks → 红果短剧中检查授权，审查、信任并启用 UserPromptSubmit、Stop、Interrupt。'

export function manualHooks() {
  return {
    status: 'manual_check',
    events: ['userPromptSubmit', 'stop', 'interrupt'].map(event => ({ event, status: 'manual_check' })),
    message: hookAuthorizationHint,
  }
}
