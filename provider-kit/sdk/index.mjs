export const providerPattern = /^[a-z][a-z0-9-]{0,31}$/
export const errorCodes = Object.freeze(['ANONYMOUS_LIMITED', 'RATE_LIMITED', 'AUTHENTICATION_REQUIRED', 'UNAUTHORIZED',
  'CONTENT_UNAVAILABLE', 'NOT_FOUND', 'NO_VIDEO', 'UNSUPPORTED_CODEC', 'ABORTED', 'TIMEOUT', 'NETWORK', 'HOST_NOT_ALLOWED', 'CONTRACT', 'MANIFEST',
  'PROVIDER_ID', 'LOAD_FAILED', 'MEDIA_EXPIRED', 'BUDGET', 'OFFLINE', 'MEDIA_FETCH', 'MEDIA_FORMAT', 'DECODE_FAILED', 'RUNTIME_UNAVAILABLE'])
export function providerError(code) {
  const safe = errorCodes.includes(code) ? code : 'NETWORK'
  return Object.assign(new Error(safe), { code: safe })
}
export function relativeFile(value, suffix = '') {
  return typeof value === 'string' && value.length <= 240 && value.endsWith(suffix) &&
    value.split('/').every(part => part.length > 0 && part !== '.' && part !== '..' && !/[\\:\x00-\x1f]/.test(part))
}
export function validateManifest(manifest, { builtin = false } = {}) {
  if (!manifest || manifest.apiVersion !== 1 || typeof manifest.id !== 'string' || !providerPattern.test(manifest.id) ||
      typeof manifest.name !== 'string' || !manifest.name.trim() || manifest.name.length > 80 ||
      typeof manifest.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw providerError('MANIFEST')
  if (manifest.network !== undefined && (!manifest.network || typeof manifest.network !== 'object' || Array.isArray(manifest.network))) throw providerError('MANIFEST')
  if ((!builtin || manifest.entry !== undefined) && (typeof manifest.entry !== 'string' || !relativeFile(manifest.entry.replace(/^\.\//, ''), '.mjs'))) throw providerError('MANIFEST')
  if (manifest.files !== undefined && (!Array.isArray(manifest.files) || manifest.files.length > 256 ||
      manifest.files.some(file => !relativeFile(file)))) throw providerError('MANIFEST')
  for (const entries of Object.values(manifest.network || {})) {
    if (!Array.isArray(entries) || entries.length > 32 || entries.some(host => typeof host !== 'string' ||
        !/^(?:\*\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}$/i.test(host))) throw providerError('MANIFEST')
  }
  for (const key of ['queryHint', 'emptyMessage'])
    if (manifest[key] !== undefined && (typeof manifest[key] !== 'string' || manifest[key].length > 160)) throw providerError('MANIFEST')
  if (manifest.queryMode !== undefined && !['search', 'link'].includes(manifest.queryMode)) throw providerError('MANIFEST')
  if (manifest.authentication !== undefined && manifest.authentication !== 'qrcode') throw providerError('MANIFEST')
  for (const key of ['nsfw', 'enabled', 'discovery', 'progressivePlayback'])
    if (manifest[key] !== undefined && typeof manifest[key] !== 'boolean') throw providerError('MANIFEST')
  if (manifest.recommendationTerms !== undefined && (!Array.isArray(manifest.recommendationTerms) || manifest.recommendationTerms.length > 6 ||
      manifest.recommendationTerms.some(term => typeof term !== 'string' || !term.trim() || term.length > 30))) throw providerError('MANIFEST')
  if (manifest.contentTypes !== undefined) {
    if (!Array.isArray(manifest.contentTypes) || !manifest.contentTypes.length || manifest.contentTypes.length > 8) throw providerError('MANIFEST')
    const ids = new Set()
    for (const type of manifest.contentTypes) {
      if (typeof type?.id !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/.test(type.id) || ids.has(type.id) ||
          typeof type.name !== 'string' || !type.name.trim() || type.name.length > 40) throw providerError('MANIFEST')
      ids.add(type.id)
      for (const key of ['queryHint', 'emptyMessage'])
        if (type[key] !== undefined && (typeof type[key] !== 'string' || type[key].length > 160)) throw providerError('MANIFEST')
      if (type.categories !== undefined) {
        if (!Array.isArray(type.categories) || type.categories.length > 32 || new Set(type.categories.map(c => c?.id)).size !== type.categories.length ||
            type.categories.some(c => typeof c?.id !== 'string' || !/^[a-z0-9-]{0,24}$/.test(c.id) || typeof c.name !== 'string' || !c.name.trim() || c.name.length > 40)) throw providerError('MANIFEST')
      }
    }
  }
  return manifest
}

function requireField(value) {
  if (!value) throw providerError('CONTRACT')
}
const validId = id => typeof id === 'string' && id.length > 0 && !id.includes('\0') && Buffer.byteLength(id) <= 96
const label = text => typeof text === 'string' && text.trim() && text.length <= 320
function series(row) {
  requireField(row && validId(row.id) && label(row.title))
  if (row.description != null) requireField(typeof row.description === 'string')
  if (row.coverURL != null) requireField(typeof row.coverURL === 'string')
  if (row.defaultEpisodeId != null) requireField(validId(row.defaultEpisodeId))
}
export function validateResult(method, value) {
  switch (method) {
    case 'getSeries': series(value); break
    case 'listSeries':
    case 'listEpisodes':
      requireField(Array.isArray(value?.items) && (value.cursor == null || typeof value.cursor === 'string'))
      if (value.series) series(value.series)
      for (const row of value.items) {
        if (method === 'listSeries') series(row)
        else requireField(validId(row?.id) && label(row.label) && Number.isFinite(row.number) &&
          (row.playable === undefined || typeof row.playable === 'boolean'))
      }
      break
    case 'getCover':
      requireField(value === null || (value?.bytes instanceof Uint8Array && value.bytes.byteLength > 0 && value.bytes.byteLength <= 3 * 1024 * 1024))
      break
    case 'resolvePlayback':
      requireField(Array.isArray(value?.candidates))
      if (!value.candidates.length) throw providerError('NO_VIDEO')
      requireField(value.fetchMedia === undefined || typeof value.fetchMedia === 'function')
      for (const item of value.candidates) {
        if (item?.kind === 'tracks') requireField(locator(item.video?.url) && locator(item.audio?.url))
        else requireField(['file', 'hls', 'dash'].includes(item?.kind) && locator(item.url))
      }
      break
    default: throw providerError('CONTRACT')
  }
  return value
}
function locator(value) {
  return typeof value === 'string' && /^https?:\/\//i.test(value)
}
export function page(items, cursor = null) { return { items, cursor } }
export function cover(bytes, mime) { return validateResult('getCover', { bytes, mime }) }
export function filePlayback(url, codec = 'h264') {
  return validateResult('resolvePlayback', { candidates: [{ kind: 'file', url, codec }] })
}
export async function fetchJSON(context, url, options = {}) {
  const response = await context.fetch(url, options)
  if (!response.ok) {
    const codes = { 401: 'AUTHENTICATION_REQUIRED', 403: 'UNAUTHORIZED', 404: 'NOT_FOUND', 429: 'RATE_LIMITED' }
    throw providerError(codes[response.status] || 'NETWORK')
  }
  return response.json()
}
