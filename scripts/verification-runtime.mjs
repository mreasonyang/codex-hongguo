import { join } from 'node:path'
import { checkInstalledFfmpeg, ffmpegPath } from '../src/runtime/ffmpeg-runtime.mjs'

// A source MCP registers as a host when it starts. Keep its registration and
// any cold download in the disposable profile, reusing an available executable.
export async function verificationRuntime(root) {
  const env = { HONGGUO_RUNTIME_DIR: join(root, 'runtime') }
  if (process.env.HONGGUO_FFMPEG) env.HONGGUO_FFMPEG = process.env.HONGGUO_FFMPEG
  else if (await checkInstalledFfmpeg()) env.HONGGUO_FFMPEG = ffmpegPath()
  return env
}
