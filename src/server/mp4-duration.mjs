import { open } from 'node:fs/promises'

// The cache remuxes inputs to fast-start MP4. Read only box headers and mvhd;
// do not scan video payloads or trust a box size to allocate an input-sized buffer.
export async function mp4DurationMs(path) {
  const file = await open(path, 'r')
  try {
    const { size: length } = await file.stat()
    async function box(offset, end) {
      const header = Buffer.alloc(16)
      const { bytesRead } = await file.read(header, 0, Math.min(16, end - offset), offset)
      if (bytesRead < 8) return
      let size = header.readUInt32BE(0), bytes = 8
      if (size === 1) {
        if (bytesRead < 16) return
        const large = header.readBigUInt64BE(8)
        if (large > BigInt(Number.MAX_SAFE_INTEGER)) return
        size = Number(large); bytes = 16
      } else if (size === 0) size = end - offset
      if (size < bytes || size > end - offset) return
      return { type: header.toString('ascii', 4, 8), payload: offset + bytes, end: offset + size }
    }
    for (let offset = 0, count = 0; offset < length && count < 1024; count++) {
      const outer = await box(offset, length)
      if (!outer) return
      if (outer.type === 'moov') {
        for (let at = outer.payload, children = 0; at < outer.end && children < 1024; children++) {
          const child = await box(at, outer.end)
          if (!child) return
          if (child.type === 'mvhd') {
            const data = Buffer.alloc(32)
            const { bytesRead } = await file.read(data, 0, Math.min(32, child.end - child.payload), child.payload)
            const version = data[0]
            if ((version === 0 && bytesRead < 20) || (version === 1 && bytesRead < 32) || version > 1) return
            const scale = data.readUInt32BE(version === 0 ? 12 : 20)
            const ticks = version === 0 ? data.readUInt32BE(16) : Number(data.readBigUInt64BE(24))
            const ms = Math.round(ticks / scale * 1000)
            return Number.isSafeInteger(ticks) && scale > 0 && ms > 0 && ms <= 86400000 ? ms : undefined
          }
          at = child.end
        }
        return
      }
      offset = outer.end
    }
  } finally { await file.close() }
}
