import { createHash } from 'node:crypto'

export function normalizeDecoyUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) throw Error('替身网址无效')
  if (!value.trim()) return ''
  const url = new URL(value.trim())
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(url.hostname) || url.href.length > 2048)
    throw Error('替身网址无效')
  return url.href
}
export function decoyOrigin(url = '') {
  try { return url ? new URL(normalizeDecoyUrl(url)).origin : '' } catch { return '' }
}
export function decoyPolicyKey(origin) {
  return origin ? createHash('sha256').update(origin).digest('hex').slice(0, 32) : 'builtin'
}
export function coverDocument(url) {
  const escaped = normalizeDecoyUrl(url).replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll("'", '&#39;')
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>替身网页</title><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;overflow:hidden;background:#fff}iframe{display:block;pointer-events:none}</style><iframe title="替身网页" tabindex="-1" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin" allow="autoplay 'none'; camera 'none'; microphone 'none'; geolocation 'none'" src="${escaped}"></iframe></html>`
}
// Only public configuration is embedded. Never insert the full custom URL into markup or CSP.
export function decoyDocument(html, settings, origin = decoyOrigin(settings.decoyUrl)) {
  const attribute = origin.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
  return html.replace('data-hover-decoy="off"',
    `data-hover-decoy="${settings.hoverDecoyEnabled ? 'on' : 'off'}" data-decoy-origin="${attribute}"`)
}
