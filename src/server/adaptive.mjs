import { Parser } from 'm3u8-parser'
import { parse as parseMpd } from 'mpd-parser'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { PlayerError } from './errors.mjs'
import { createDecipheriv } from 'node:crypto'

const invalid = () => new PlayerError('该分段片源暂不支持，可重试其他片源')
function audioFor(master, variant) {
  const group = master.mediaGroups?.AUDIO?.[variant.attributes?.AUDIO] || {}
  const renditions = Object.values(group)
  return renditions.find((a) => a.default) || renditions[0]
}

async function tracks(url, read, hlsOnly, depth = 0) {
  if (depth > 3) throw invalid()
  const page = await read(url, 256 * 1024)
  const body = page.bytes.toString('utf8').trimStart()
  if (body.startsWith('#EXTM3U')) {
    for (const line of body.split(/\r?\n/).filter(line => /^#EXT-X-(?:KEY|SESSION-KEY):/.test(line))) {
      if (line.startsWith('#EXT-X-SESSION-KEY:') || !/METHOD=(?:AES-128|NONE)(?:,|$)/.test(line) ||
          (/KEYFORMAT=/.test(line) && !/KEYFORMAT="identity"(?:,|$)/.test(line))) throw invalid()
    }
    const parser = new Parser()
    parser.push(body)
    parser.end()
    const master = parser.manifest
    if (!master.playlists?.length) return [{ playlist: master, base: page.url }]
    const variant = master.playlists[0]
    const video = await tracks(new URL(variant.uri, page.url), read, hlsOnly, depth + 1)
    const audio = audioFor(master, variant)
    if (audio?.uri && video.length === 1) {
      const [a] = await tracks(new URL(audio.uri, page.url), read, hlsOnly, depth + 1)
      video.push(a)
    }
    return video
  }
  if (hlsOnly || !/<MPD[\s>]/.test(body) || /<!DOCTYPE|<!ENTITY|<ContentProtection|type\s*=\s*["']dynamic/i.test(body))
    throw invalid()
  // Bound template and timeline expansion before invoking the DASH parser.
  const duration = body.match(/mediaPresentationDuration=["']PT(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?["']/)
  if (!duration) throw invalid()
  const seconds = (+duration[1] || 0) * 3600 + (+duration[2] || 0) * 60 + (+duration[3] || 0)
  if (!(seconds > 0 && seconds <= 3600)) throw invalid()
  const attributes = (re) => Array.from(body.matchAll(re), (m) => Number(m[1]))
  const scales = attributes(/\btimescale\s*=\s*["'](.*?)["']/g)
  const repeats = attributes(/\br\s*=\s*["'](.*?)["']/g)
  if (
    scales.some((n) => !Number.isSafeInteger(n) || n < 1 || n > 1e9) ||
    repeats.some((n) => !Number.isSafeInteger(n) || n < 0 || n > 2048) ||
    repeats.reduce((a, b) => a + b, 0) > 8192 ||
    (body.match(/<Representation\b/g) || []).length > 32 ||
    (body.match(/<S\s/g) || []).length > 4096
  )
    throw invalid()
  for (const ticks of attributes(/\b(?:d|duration)\s*=\s*["']([\d.]+)["']/g)) {
    if (!(ticks > 0) || (seconds * Math.max(1, ...scales)) / ticks > 8192) throw invalid()
  }
  const master = parseMpd(body, { manifestUri: page.url })
  const video = master.playlists?.[0]
  if (!video?.segments?.length) throw invalid()
  const audio = audioFor(master, video)?.playlists?.[0]
  return [video, audio].filter(Boolean).map((playlist) => ({ playlist, base: page.url }))
}

export async function prepareAdaptive(source, dir, output, { cdn, run, codec, budget, firstHlsSegment = false }) {
  const deadline = Date.now() + 180000
  async function read(url, limit, range) {
    const remaining = Math.min(limit, budget)
    if (remaining <= 0 || range?.length > budget) throw Object.assign(invalid(), { code: 'BUDGET' })
    if (Date.now() >= deadline) throw invalid()
    const response = await cdn(url, remaining, Math.min(20000, deadline - Date.now()), 0, range)
    let count = 0
    const chunks = []
    for await (const chunk of response.body) {
      count += chunk.byteLength
      if (count > remaining) throw Object.assign(invalid(), { code: 'BUDGET' })
      chunks.push(chunk)
    }
    if (!count || (range && count !== range.length)) throw invalid()
    budget -= count
    return { bytes: Buffer.concat(chunks), url: response.url }
  }
  const media = await tracks(source, read, firstHlsSegment)
  const inputs = []
  for (const [index, { playlist, base }] of media.entries()) {
    const segments = playlist.segments
    if (!playlist.endList || !segments?.length || segments.length > 2048) throw invalid()
    const path = join(dir, 'track' + index),
      out = await open(path, 'wx', 0o600)
    let init
    try {
      // A doctor sample still needs each selected track's initialization data and key.
      for (const segment of firstHlsSegment ? segments.slice(0, 1) : segments) {
        if (segment.discontinuity || segment.gap) throw invalid()
        const keyInfo = segment.key
        if (keyInfo && (keyInfo.method !== 'AES-128' || !keyInfo.uri || segment.map || segment.byterange)) throw invalid()
        for (const item of [segment.map, segment]) {
          if (!item) continue
          const url = new URL(item.resolvedUri || item.uri, base)
          const id = JSON.stringify([url.href, item.byterange])
          if (item === segment.map && init === id) continue
          if (item === segment.map && init) throw invalid()
          let { bytes } = await read(url, 32 * 1024 * 1024, item.byterange)
          if (keyInfo) {
            // Keys are intentionally not cached by URL: a new KEY declaration can reuse that URI.
            const key = (await read(new URL(keyInfo.uri, base), 16)).bytes
            try {
              if (key.length !== 16 || !bytes.length || bytes.length % 16) throw invalid()
              const iv = Buffer.alloc(16)
              if (keyInfo.iv) {
                if (keyInfo.iv.length !== 4) throw invalid()
                Array.from(keyInfo.iv).forEach((n, i) => iv.writeUInt32BE(n, i * 4))
              } else {
                const sequence = (playlist.mediaSequence || 0) + segments.indexOf(segment)
                if (!Number.isSafeInteger(sequence) || sequence < 0) throw invalid()
                iv.writeBigUInt64BE(BigInt(sequence), 8)
              }
              const decipher = createDecipheriv('aes-128-cbc', key, iv)
              bytes = Buffer.concat([decipher.update(bytes), decipher.final()])
            } catch { throw invalid() }
            finally { key.fill(0) }
          }
          await out.writeFile(bytes)
          if (item === segment.map) init = id
        }
      }
    } finally {
      await out.close()
    }
    inputs.push('-protocol_whitelist', 'file', '-f', init ? 'mov' : 'mpegts', '-i', path)
  }
  await run([
    ...inputs,
    '-map',
    '0:v:0',
    '-map',
    media.length === 2 ? '1:a:0' : '0:a:0?',
    '-c',
    'copy',
    ...(/hevc|h265|bytevc1/i.test(codec) ? ['-tag:v', 'hvc1'] : []),
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    output,
  ])
}
