import { createWriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PlayerError } from './errors.mjs'

// Separate progressive MP4 video/audio tracks are common in DASH JSON APIs.
// Fetch only through the provider transport; FFmpeg receives local paths only.
export async function prepareTracks(stream, directory, output, { cdn, run, budget }) {
  if (!stream.video?.url || !stream.audio?.url || stream.encryption) throw new PlayerError('双轨片源信息无效')
  const deadline = Date.now() + 180000, inputs = []
  for (const [index, track] of [stream.video, stream.audio].entries()) {
    const path = join(directory, 'track' + index), urls = [...new Set([track.url, ...(track.backupURLs || [])])].slice(0, 4)
    let lastError
    for (const url of urls) {
      try {
        if (budget <= 0 || Date.now() >= deadline) throw new PlayerError('媒体准备超过大小或时间限制')
        const response = await cdn(url, budget, Math.min(120000, deadline - Date.now()))
        const limit = new Transform({ transform(chunk, _encoding, done) {
          budget -= chunk.length
          done(budget < 0 ? new PlayerError('素材超过大小限制') : null, chunk)
        } })
        await pipeline(response.body, response.limit, limit, createWriteStream(path, { flags: 'wx', mode: 0o600 }))
        lastError = null; break
      } catch (error) { lastError = error; await rm(path, { force: true }) }
    }
    if (lastError) throw lastError
    inputs.push('-protocol_whitelist', 'file', '-f', 'mov', '-i', path)
  }
  await run([...inputs, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy',
    '-movflags', '+faststart', '-f', 'mp4', output])
}
