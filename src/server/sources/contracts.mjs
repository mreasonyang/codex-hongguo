import { createHash } from 'node:crypto'
import { PlayerError } from '../errors.mjs'

// All locators, authorization material and request contexts stay inside the Host.
// Public models contain qualified IDs; adapters operate on provider-local IDs.
export function sourceError(error) {
  if (error instanceof PlayerError) return error
  const labels = {
    ANONYMOUS_LIMITED: '上游暂时限制匿名播放', RATE_LIMITED: '请求过于频繁',
    AUTHENTICATION_REQUIRED: '片源需要登录', UNAUTHORIZED: '片源需要登录',
    CONTENT_UNAVAILABLE: '片源暂不可用', NOT_FOUND: '剧目已下架或不存在',
    NO_VIDEO: '该集暂未提供可播放的片源', ABORTED: '请求已取消',
  }
  const result = new PlayerError((labels[error?.code] || '片源暂时不可达') + '，请稍后重试', 503)
  result.code = error?.status === 429 ? 'RATE_LIMITED' : (Object.hasOwn(labels, error?.code) ? error.code : 'NETWORK')
  if (result.code === 'RATE_LIMITED') result.message = '请求过于频繁，请稍后重试'
  return result
}
export async function sourceCall(fn, signal) {
  if (signal?.aborted) throw new PlayerError('请求已取消', 499)
  let timer, abort
  try {
    const stop = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new PlayerError('片源请求超时，请重试', 503)), 30000)
      abort = () => reject(new PlayerError('请求已取消', 499))
      signal?.addEventListener('abort', abort, { once: true })
    })
    const result = await Promise.race([fn(), stop])
    if (signal?.aborted) throw new PlayerError('请求已取消', 499)
    return result
  } catch (error) { throw sourceError(error) }
  finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort) }
}
const binding = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 24)
export function encodeCursor(source, operation, scope, state) {
  if (state === undefined || state === null || state === '') return null
  const cursor = 'v1.' + Buffer.from(JSON.stringify({ source, operation, scope: binding(scope), state })).toString('base64url')
  if (cursor.length > 4096) throw new PlayerError('分页信息过长')
  return cursor
}
export function decodeCursor(cursor, source, operation, scope) {
  if (!cursor) return undefined
  if (typeof cursor !== 'string' || cursor.length > 4096) throw new PlayerError('分页信息无效')
  // Already-open pre-adapter Hongguo panels may finish their original native cursor.
  if (!cursor.startsWith('v1.') && source === 'hongguo') return cursor
  try {
    const value = JSON.parse(Buffer.from(cursor.substring(3), 'base64url').toString('utf8'))
    if (value.source !== source || value.operation !== operation || value.scope !== binding(scope)) throw Error()
    return value.state
  } catch { throw new PlayerError('分页信息与当前片源或查询不匹配') }
}
export function filePlayback(result) {
  const { playback = {}, contentKey } = result
  const streams = (playback.streams || []).filter(s => s.url)
  const files = streams.filter(s => !s.hls && !s.dash)
  const file = files.find(s => !/bytevc2/i.test(s.codec || '')) || files[0]
  return { candidates: [...new Set([
    file && (file.protected || playback.protected) ? file : undefined,
    streams.find(s => s.hls), streams.find(s => s.dash), file,
  ].filter(Boolean))].flatMap(s => [...new Set([s.url, s.backup_url].filter(Boolean))].map(url => ({
    kind: s.hls ? 'hls' : s.dash ? 'dash' : 'file', url, codec: s.codec,
    ...(s.protected || playback.protected ? { encryption: { kind: 'cenc', key: contentKey?.key } } : {}),
  }))) }
}
