import { readFileSync } from 'node:fs'

export const npmPackageName = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name
export const marketplaceName = 'hongguo-local'
export function marketplace(version, source = { source: 'npm', package: npmPackageName, version }) {
  return {
    name: marketplaceName,
    interface: { displayName: '红果短剧' },
    plugins: [{ name: 'codex-hongguo', source, policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' }, category: 'Entertainment' }],
  }
}
