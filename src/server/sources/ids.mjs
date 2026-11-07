import { PlayerError } from '../errors.mjs'

export const sourceIds = ['hongguo', 'hghub']
export const providerPattern = /^[a-z][a-z0-9-]{0,31}$/
export const seriesPattern = /^(?:hg-[0-9]{1,32}|hh-[0-9]{1,32}|p\.[a-z][a-z0-9-]{0,31}\.s\.[A-Za-z0-9_-]{1,128})$/
export const episodePattern = /^(?:hg-[0-9]{1,32}|hh-[0-9]{1,32}_[1-9][0-9]{0,5}|p\.[a-z][a-z0-9-]{0,31}\.e\.[A-Za-z0-9_-]{1,128})$/
export function sourceId(value = 'hongguo') {
  if (typeof value !== 'string' || !providerPattern.test(value)) throw new PlayerError('无效片源')
  return value
}
export function parseId(value, kind = 'series') {
  if (typeof value !== 'string' || !(kind === 'episode' ? episodePattern : seriesPattern).test(value))
    throw new PlayerError(kind === 'episode' ? '无效分集' : '无效剧目')
  if (!value.startsWith('p.')) return { source: value.startsWith('hg-') ? 'hongguo' : 'hghub', id: value.substring(3) }
  const [, source, , encoded] = value.split('.')
  const id = Buffer.from(encoded, 'base64url').toString('utf8')
  if (!id || id.includes('\0') || Buffer.from(id).toString('base64url') !== encoded || sourceIds.includes(source))
    throw new PlayerError('无效资源标识')
  return { source, id }
}
export function qualify(source, id, kind = 'series') {
  sourceId(source)
  const value = sourceIds.includes(source) ? (source === 'hongguo' ? 'hg-' : 'hh-') + String(id)
    : 'p.' + source + '.' + (kind === 'episode' ? 'e' : 's') + '.' + Buffer.from(String(id)).toString('base64url')
  parseId(value, kind)
  return value
}
export function matchesSeries(series, episode) {
  const s = parseId(series), e = parseId(episode, 'episode')
  return s.source === e.source && (s.source !== 'hghub' || e.id.startsWith(s.id + '_'))
}
export function belongsTo(value, source, kind = 'series') {
  try { return parseId(value, kind).source === sourceId(source) } catch { return false }
}
export function idGlob(source, kind = 'series') {
  sourceId(source)
  return source === 'hongguo' ? 'hg-*' : source === 'hghub' ? 'hh-*' : 'p.' + source + '.' + (kind === 'episode' ? 'e' : 's') + '.*'
}
