import { Parser } from 'm3u8-parser'
import { createDecipheriv } from 'node:crypto'
import { responseBytes } from './sources/network.mjs'
import { PlayerError } from './errors.mjs'

const MB = 1024 * 1024
const invalid = () => new PlayerError('片源分段索引无效，请重新点播')

// Resolve only the index. URLs and AES keys stay in the Host; the panel sees
// generated asset names and fetches just the fragments around its playhead.
export async function hlsIndex(candidate, fetch, signal, valid) {
  async function index(url, depth = 0) {
    if (depth > 3) throw invalid()
    const response = await fetch(url, 256 * 1024, 20000, 0, undefined, signal)
    const text = (await responseBytes(response.body, 256 * 1024)).toString('utf8').trimStart()
    valid()
    if (!text.startsWith('#EXTM3U')) throw invalid()
    for (const line of text.split(/\r?\n/).filter(line => /^#EXT-X-(?:KEY|SESSION-KEY):/.test(line))) {
      if (line.startsWith('#EXT-X-SESSION-KEY:') || !/METHOD=(?:AES-128|NONE)(?:,|$)/.test(line) ||
          (/KEYFORMAT=/.test(line) && !/KEYFORMAT="identity"(?:,|$)/.test(line))) throw invalid()
    }
    const parser = new Parser(); parser.push(text); parser.end()
    const playlist = parser.manifest
    if (playlist.playlists?.length) {
      const variant = playlist.playlists.find(row => /avc[13]\./i.test(row.attributes?.CODECS || '')) || playlist.playlists[0]
      const audio = Object.values(playlist.mediaGroups?.AUDIO?.[variant.attributes?.AUDIO] || {})
      if (audio.some(row => row.uri)) return null // Existing compatibility path handles separate tracks.
      return index(new URL(variant.uri, response.url), depth + 1)
    }
    if (!playlist.endList || !playlist.segments?.length || playlist.segments.length > 32768) throw invalid()
    if (playlist.segments.some(row => row.map || row.byterange)) return null
    const assets = new Map(), lines = [], sequence = playlist.mediaSequence || 0
    let duration = 0, maximum = 0
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw invalid()
    for (const [i, segment] of playlist.segments.entries()) {
      if (!(segment.duration > 0 && Number.isFinite(segment.duration)) || segment.gap ||
          !Number.isSafeInteger(sequence + i)) throw invalid()
      const key = segment.key
      if (key && (key.method !== 'AES-128' || !key.uri)) throw invalid()
      const iv = Buffer.alloc(16)
      if (key?.iv) {
        if (key.iv.length !== 4) throw invalid()
        Array.from(key.iv).forEach((n, index) => {
          if (!Number.isSafeInteger(n) || n < 0 || n > 0xffffffff) throw invalid()
          iv.writeUInt32BE(n, index * 4)
        })
      } else iv.writeBigUInt64BE(BigInt(sequence + i), 8)
      const name = 'seg' + String(i).padStart(5, '0') + '.ts'
      assets.set(name, { url: new URL(segment.resolvedUri || segment.uri, response.url).href,
        key, keyURL: key ? new URL(key.uri, response.url).href : undefined, iv })
      if (segment.discontinuity) lines.push('#EXT-X-DISCONTINUITY')
      lines.push('#EXTINF:' + segment.duration.toFixed(6) + ',', name)
      duration += segment.duration; maximum = Math.max(maximum, segment.duration)
    }
    if (!(duration > 0 && duration <= 86400)) throw invalid()
    const manifest = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:' + Math.ceil(maximum),
      '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-PLAYLIST-TYPE:VOD', ...lines, '#EXT-X-ENDLIST', ''].join('\n')
    if (manifest.length > MB) throw invalid()
    return { manifest, assets, durationMs: Math.round(duration * 1000), keys: new Map() }
  }
  return index(candidate.url)
}

export async function hlsBytes(e, asset, valid) {
  const read = async (url, budget) => {
    const response = await e.fetch(url, budget, 30000, 0, undefined, e.abort.signal)
    const bytes = await responseBytes(response.body, budget)
    valid()
    if (!bytes.length) throw invalid()
    return bytes
  }
  // Parser key objects identify declarations, including rotations that reuse a URL.
  // Share a declaration's in-memory fetch, never a key indexed only by its URI.
  let pendingKey
  if (asset.key) {
    pendingKey = e.keys.get(asset.key)
    if (!pendingKey) {
      pendingKey = read(asset.keyURL, 16).then(key => {
        if (key.length !== 16) { key.fill(0); throw invalid() }
        return key
      })
      e.keys.set(asset.key, pendingKey)
      pendingKey.catch(() => { if (e.keys.get(asset.key) === pendingKey) e.keys.delete(asset.key) })
    }
  }
  const [encrypted, key] = await Promise.all([read(asset.url, 32 * MB), pendingKey])
  valid()
  if (!key) return encrypted
  if (encrypted.length % 16) throw invalid()
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, asset.iv)
    return Buffer.concat([decipher.update(encrypted), decipher.final()])
  } catch { throw invalid() }
}

export function clearHlsKeys(e) {
  for (const key of e.keys?.values() || []) key.then(bytes => bytes.fill(0), () => {})
  e.keys?.clear()
}
