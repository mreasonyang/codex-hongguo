import { createHash } from 'node:crypto'
import { PlayerError } from '../errors.mjs'
import { errorCodes } from '../../../provider-kit/sdk/index.mjs'

// All locators, authorization material and request contexts stay inside the Host.
// Public models contain qualified IDs; adapters operate on provider-local IDs.
export function sourceError(error) {
  if (error instanceof PlayerError) return error
  const labels = {
    ANONYMOUS_LIMITED: '上游暂时限制匿名播放', RATE_LIMITED: '请求过于频繁',
    AUTHENTICATION_REQUIRED: '片源需要登录', UNAUTHORIZED: '片源需要登录',
    CONTENT_UNAVAILABLE: '片源暂不可用', NOT_FOUND: '剧目已下架或不存在',
    NO_VIDEO: '该集暂未提供可播放的片源', UNSUPPORTED_CODEC: '该集暂未提供兼容编码', CONTRACT: '片源返回的数据格式无效', OFFLINE: '离线检查需要测试数据',
    BUDGET: '超过诊断预算', TIMEOUT: '片源请求超时', ABORTED: '请求已取消',
    HOST_NOT_ALLOWED: '片源配置未允许此域名', MEDIA_EXPIRED: '媒体地址已失效',
    MEDIA_FETCH: '无法获取媒体', MEDIA_FORMAT: '媒体格式不受支持', DECODE_FAILED: '媒体解码失败',
    LOAD_FAILED: '片源加载失败', MANIFEST: '片源清单无效', RUNTIME_UNAVAILABLE: '播放组件未就绪',
  }
  const code = error?.status === 429 ? 'RATE_LIMITED' : (errorCodes.includes(error?.code) ? error.code : 'NETWORK')
  const result = new PlayerError((labels[code] || '片源暂时不可达') + '，请稍后重试', 503)
  result.code = code
  return result
}
export async function sourceCall(fn, signal) {
  const controller = new AbortController()
  const request = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const failure = () => Object.assign(new PlayerError(signal?.aborted ? '请求已取消' : '片源请求超时，请重试', signal?.aborted ? 499 : 503),
    { code: signal?.aborted ? 'ABORTED' : 'TIMEOUT' })
  if (request.aborted) throw failure()
  let rejectRequest
  const stop = new Promise((_, reject) => { rejectRequest = () => reject(failure()) })
  request.addEventListener('abort', rejectRequest, { once: true })
  const timer = setTimeout(() => controller.abort(), 30000)
  try {
    const result = await Promise.race([fn(request), stop])
    if (request.aborted) throw failure()
    return result
  } catch (error) { throw request.aborted ? failure() : sourceError(error) }
  finally { clearTimeout(timer); request.removeEventListener('abort', rejectRequest) }
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
    if (!cursor.startsWith('v1.')) throw Error()
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
  ].filter(Boolean))].flatMap(s => {
    const urls = [...new Set([s.url, s.backup_url].filter(Boolean))]
    return urls.map(url => ({
      kind: s.hls ? 'hls' : s.dash ? 'dash' : 'file', url, codec: s.codec,
      // Mirrors belong to this exact file, never another quality or encoding.
      ...(!s.hls && !s.dash && urls.length > 1 ? { backupURLs: urls.filter(other => other !== url) } : {}),
      ...(s.protected || playback.protected ? { encryption: { kind: 'cenc', key: contentKey?.key } } : {}),
    }))
  }) }
}
