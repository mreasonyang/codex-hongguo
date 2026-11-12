import { Transform } from 'node:stream'
import { PlayerError } from '../errors.mjs'

export const hongguoHosts = /(?:^|\.)(?:qznovelvod\.com|byteimg\.com|fqnovelpic\.com|douyinvod\.com|bytecdn\.cn|ibytedtos\.com|snssdk\.com|pstatp\.com)$/i
// Some qznovelvod media replies redirect through this CDN routing domain.
// It is accepted only after an allowed initial URL, not as a direct locator.
export const allowsHongguoRedirect = host => hongguoHosts.test(host) || /(?:^|\.)(?:bdcgslb\.com|jspcdn\.cn)$/i.test(host)
// Observed in HTTPS redirects issued by qznovelvod. Keep this exception
// restricted to the routing destination; direct URLs still reject all ports.
export const allowsHongguoRedirectPort = url => /(?:^|\.)jspcdn\.cn$/i.test(url.hostname) && url.port === '20443'
const overBudget = () => Object.assign(new PlayerError('素材超过大小限制'), { code: 'BUDGET' })
const invalid = () => new PlayerError('片源地址不在支持的媒体域名内')
export function allowedURL(input, allows, allowsPort = () => false) {
  let url
  try { url = new URL(input) } catch { throw invalid() }
  if (url.protocol === 'http:') url.protocol = 'https:'
  if (url.protocol !== 'https:' || (url.port && !allowsPort(url)) || url.username || url.password) throw invalid()
  if (!allows(url.hostname)) throw Object.assign(invalid(), { code: 'HOST_NOT_ALLOWED' })
  return url
}
export async function boundedResponse(input, {
  allows, budget, timeout = 10000, signal, headers = {}, method = 'GET', body, range, followRedirects = true,
}, { redirectAllows = allows, redirectPorts } = {}) {
  const deadline = Date.now() + timeout
  let target = allowedURL(input, allows)
  for (let redirect = 0; redirect <= 3; redirect++) {
    const requestHeaders = new Headers(typeof headers === 'function' ? headers(target) : headers)
    if (range) {
      if (!Number.isSafeInteger(range.offset) || range.offset < 0 || !Number.isSafeInteger(range.length) ||
          range.length < 1 || range.length > budget || !Number.isSafeInteger(range.offset + range.length))
        throw new PlayerError('片源字节范围无效')
      requestHeaders.set('Range', 'bytes=' + range.offset + '-' + (range.offset + range.length - 1))
    }
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new PlayerError('片源请求超时，请重试', 503)
    const signals = [AbortSignal.timeout(remaining), ...(signal ? [signal] : [])]
    const outgoing = Object.fromEntries(requestHeaders)
    if (range) { outgoing.Range = outgoing.range; delete outgoing.range }
    const res = await fetch(target, { headers: outgoing, method, body,
      redirect: 'manual', signal: AbortSignal.any(signals) })
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      if (!followRedirects) return { response: res, url: target.href }
      const location = res.headers.get('location'); await res.body?.cancel()
      if (!location || redirect === 3) throw invalid()
      const next = allowedURL(new URL(location, target), redirectAllows, redirectPorts)
      // Never forward an authenticated request to another origin.
      if (next.origin !== target.origin && (requestHeaders.has('authorization') || requestHeaders.has('cookie'))) throw invalid()
      if (res.status === 303 || ([301, 302].includes(res.status) && method === 'POST')) { method = 'GET'; body = undefined }
      target = next; continue
    }
    if (res.body && Number(res.headers.get('content-length')) > budget) {
      await res.body?.cancel(); throw overBudget()
    }
    return { response: res, url: target.href }
  }
  throw invalid()
}
export function mediaFetcher({ allows = host => hongguoHosts.test(host), redirectAllows = allows, redirectPorts = () => false, headers = {}, signal: lifetime } = {}) {
  return async (url, budget, timeout, _redirects = 0, range, signal) => {
    const signals = [lifetime, signal].filter(Boolean)
    const { response: res, url: finalURL } = await boundedResponse(url, { allows, headers, budget, timeout, range,
      signal: signals.length ? AbortSignal.any(signals) : undefined }, { redirectAllows, redirectPorts })
    const validRange = !range || (res.status === 206 && res.headers.get('content-range')?.split('/')[0] ===
      'bytes ' + range.offset + '-' + (range.offset + range.length - 1))
    if (!res.ok || !res.body || !validRange) {
      await res.body?.cancel()
      const error = new PlayerError('媒体地址已失效或超过大小限制，请重试', 503)
      if ([401, 403, 410].includes(res.status)) error.code = 'MEDIA_EXPIRED'
      throw error
    }
    let bytes = 0
    const limit = new Transform({ transform(chunk, _encoding, done) {
      bytes += chunk.length; done(bytes > budget ? overBudget() : null, chunk)
    } })
    const total = Number(res.headers.get('content-range')?.split('/')[1])
    return { body: res.body, limit, url: finalURL, ...(range && Number.isSafeInteger(total) && total > 0 ? { totalBytes: total } : {}) }
  }
}
export const cdn = mediaFetcher({ redirectAllows: allowsHongguoRedirect, redirectPorts: allowsHongguoRedirectPort })
export async function responseBytes(body, budget) {
  const chunks = []; let size = 0
  for await (const chunk of body) {
    size += chunk.length
    if (size > budget) throw overBudget()
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}
