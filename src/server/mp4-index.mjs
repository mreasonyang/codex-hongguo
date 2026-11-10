import { PlayerError } from './errors.mjs'

const invalid = () => new PlayerError('视频索引不完整或暂不支持，请重试')
const maxSamples = 2_000_000
export function boxes(bytes, start = 0, end = bytes.length) {
  const result = []
  for (let p = start; p < end;) {
    if (p + 8 > end || result.length >= 4096) throw invalid()
    let size = bytes.readUInt32BE(p), header = 8
    if (size === 1) { if (p + 16 > end) throw invalid(); size = Number(bytes.readBigUInt64BE(p + 8)); header = 16 }
    if (size === 0) size = end - p
    if (!Number.isSafeInteger(size) || size < header || p + size > end) throw invalid()
    result.push({ type: bytes.toString('ascii', p + 4, p + 8), start: p, payload: p + header, end: p + size })
    p += size
  }
  return result
}
function child(bytes, parent, type) {
  const b = boxes(bytes, parent.payload, parent.end).find(row => row.type === type)
  if (!b) throw invalid()
  return b
}
function table(bytes, box, width, countOffset = 4) {
  const p = box.payload, count = bytes.readUInt32BE(p + countOffset)
  if (count > maxSamples || p + countOffset + 4 + count * width !== box.end) throw invalid()
  return { count, start: p + countOffset + 4 }
}
// Keep the original sample/chunk offsets. A private sparse input contains only
// the index, probe samples and the requested time window; FFmpeg can seek in it.
export function movieIndex(bytes, fileSize) {
  try {
    const moov = boxes(bytes).find(b => b.type === 'moov')
    if (!moov) throw invalid()
    const mvhd = child(bytes, moov, 'mvhd'), v = bytes[mvhd.payload]
    if (v > 1) throw invalid()
    const scale = bytes.readUInt32BE(mvhd.payload + (v ? 20 : 12))
    const ticks = v ? Number(bytes.readBigUInt64BE(mvhd.payload + 24)) : bytes.readUInt32BE(mvhd.payload + 16)
    const durationMs = Math.round(ticks / scale * 1000)
    if (!(durationMs > 0 && durationMs <= 86400000)) throw invalid()
    const tracks = []
    for (const trak of boxes(bytes, moov.payload, moov.end).filter(b => b.type === 'trak')) {
      const mdia = child(bytes, trak, 'mdia'), handler = child(bytes, mdia, 'hdlr')
      const kind = bytes.toString('ascii', handler.payload + 8, handler.payload + 12)
      if (!['vide', 'soun'].includes(kind)) continue
      if (tracks.length >= 4) throw invalid()
      const mdhd = child(bytes, mdia, 'mdhd'), version = bytes[mdhd.payload]
      if (version > 1) throw invalid()
      const timescale = bytes.readUInt32BE(mdhd.payload + (version ? 20 : 12))
      if (!timescale) throw invalid()
      const stbl = child(bytes, child(bytes, mdia, 'minf'), 'stbl')
      const tables = boxes(bytes, stbl.payload, stbl.end)
      const find = type => { const b = tables.find(b => b.type === type); if (!b) throw invalid(); return b }
      const sz = find('stsz'), fixed = bytes.readUInt32BE(sz.payload + 4), count = bytes.readUInt32BE(sz.payload + 8)
      if (!count || count > maxSamples || sz.payload + 12 + (fixed ? 0 : count * 4) !== sz.end) throw invalid()
      const sizes = Array.from({ length: count }, (_, i) => fixed || bytes.readUInt32BE(sz.payload + 12 + i * 4))
      const timing = find('stts'), tt = table(bytes, timing, 8), times = new Float64Array(count + 1)
      let sample = 0, time = 0
      for (let i = 0; i < tt.count; i++) {
        const p = tt.start + i * 8, n = bytes.readUInt32BE(p), delta = bytes.readUInt32BE(p + 4)
        if (!n || !delta || sample + n > count) throw invalid()
        for (let j = 0; j < n; j++) { times[sample++] = time / timescale; time += delta }
      }
      if (sample !== count || time / timescale > 86402) throw invalid()
      times[count] = time / timescale
      const offsets = tables.find(b => b.type === 'stco' || b.type === 'co64')
      if (!offsets) throw invalid()
      const wide = offsets.type === 'co64', ot = table(bytes, offsets, wide ? 8 : 4)
      const mapping = table(bytes, find('stsc'), 12)
      const maps = Array.from({ length: mapping.count }, (_, i) => {
        const p = mapping.start + i * 12
        return { first: bytes.readUInt32BE(p), count: bytes.readUInt32BE(p + 4) }
      })
      if (maps[0]?.first !== 1 || maps.some((r, i) => !r.count || r.first > ot.count || (i && r.first <= maps[i - 1].first))) throw invalid()
      const chunks = []; sample = 0; let m = 0
      for (let i = 0; i < ot.count; i++) {
        if (maps[m + 1]?.first === i + 1) m++
        const n = maps[m].count, p = ot.start + i * (wide ? 8 : 4)
        const offset = wide ? Number(bytes.readBigUInt64BE(p)) : bytes.readUInt32BE(p)
        if (sample + n > count) throw invalid()
        let length = 0
        for (let s = sample; s < sample + n; s++) length += sizes[s]
        if (!Number.isSafeInteger(offset) || !length || offset + length > fileSize) throw invalid()
        chunks.push({ offset, length, first: sample, last: sample + n - 1 })
        sample += n
      }
      if (sample !== count) throw invalid()
      const sync = tables.find(b => b.type === 'stss')
      let keys
      if (sync) {
        const t = table(bytes, sync, 4)
        keys = Array.from({ length: t.count }, (_, i) => bytes.readUInt32BE(t.start + i * 4) - 1)
        if (!keys.length || keys.some((s, i) => s < 0 || s >= count || (i && s <= keys[i - 1]))) throw invalid()
      }
      // External CENC auxiliary data is uncommon here. Reject it rather than
      // decrypting against zero-filled holes. Inline senc in moov is supported.
      if (tables.some(b => b.type === 'saio') && !tables.some(b => b.type === 'senc')) throw invalid()
      tracks.push({ kind, times, chunks, keys })
    }
    if (!tracks.some(t => t.kind === 'vide')) throw invalid()
    return { durationMs, tracks }
  } catch { throw invalid() }
}
export function windowRanges(index, start, end) {
  const ranges = []
  for (const track of index.tracks) {
    let first = 0
    while (first + 1 < track.times.length - 1 && track.times[first + 1] <= Math.max(0, start - 1)) first++
    if (track.keys) first = track.keys.findLast(s => s <= first) ?? 0
    let last = first
    while (last + 1 < track.times.length - 1 && track.times[last] < end + 2) last++
    for (const c of track.chunks) if (c.last >= first && c.first <= last) ranges.push({ offset: c.offset, length: c.length })
  }
  const merged = []
  for (const r of ranges.sort((a, b) => a.offset - b.offset)) {
    const last = merged.at(-1)
    if (last && r.offset <= last.offset + last.length + 4096) last.length = Math.max(last.offset + last.length, r.offset + r.length) - last.offset
    else merged.push({ ...r })
  }
  if (merged.reduce((n, r) => n + r.length, 0) > 32 * 1024 * 1024) throw invalid()
  return merged
}
