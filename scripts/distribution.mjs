export const marketplaceName = 'hongguo-local'
export function marketplace(version, source = { source: 'npm', package: 'codex-hongguo', version }) {
  return {
    name: marketplaceName,
    interface: { displayName: '红果短剧' },
    plugins: [{ name: 'codex-hongguo', source, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Entertainment' }],
  }
}
