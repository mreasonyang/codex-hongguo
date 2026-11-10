/*! SPDX-License-Identifier: GPL-3.0-only
 * Cover decoding adapted from gybeyond1/Veyra desktop/src/main/huangguo.ts
 * Commit: a83dfd9a29b23d439da4f853d104568696cd401c
 * Local changes: recognize WebP/AVIF/HEIC and remove valid PKCS7 padding.
 * See third_party/veyra/NOTICE.md and LICENSE.
 */
import { createDecipheriv } from 'node:crypto'

function isImage(value) {
  return value.length > 16 && ((value[0] === 0xff && value[1] === 0xd8) ||
    value.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) ||
    value.subarray(0, 4).toString('latin1') === 'GIF8' ||
    (value.subarray(0, 4).toString('latin1') === 'RIFF' && value.subarray(8, 12).toString('latin1') === 'WEBP') ||
    (value.subarray(4, 8).toString('latin1') === 'ftyp' && /^(avif|avis|heic|heix|mif1)$/.test(value.subarray(8, 12).toString('latin1'))))
}
export function decodeCover(buffer) {
  let data = Buffer.from(buffer)
  if (!isImage(data)) {
    try {
      // Public site-format constants, not account credentials.
      const decipher = createDecipheriv('aes-128-cbc',
        Buffer.from('f5d965df75336270'), Buffer.from('97b60374abc2fbe1'))
      decipher.setAutoPadding(false)
      data = Buffer.concat([decipher.update(data), decipher.final()])
      const padding = data.at(-1)
      if (padding > 0 && padding <= 16 && data.subarray(-padding).every(byte => byte === padding)) data = data.subarray(0, -padding)
    } catch { return null }
  }
  if (data.length > 12 && data.subarray(0, 7).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x14]))) data[6] = 0x1a
  return isImage(data) ? data : null
}
