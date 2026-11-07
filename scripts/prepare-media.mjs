import { ensureFfmpeg } from '../src/runtime/ffmpeg-runtime.mjs'
try {
  await ensureFfmpeg()
  console.log('插件管理的播放组件已就绪')
} catch (error) {
  // Keep runtime/network paths, URLs, headers and raw exception details out of CI logs.
  const codes = new Set(['download', 'download-url', 'download-http', 'download-network',
    'archive-size', 'archive-hash', 'extract', 'binary-hash', 'probe', 'publish'])
  console.error('播放组件自动准备失败 ' + JSON.stringify({
    platform: process.platform, arch: process.arch,
    stage: codes.has(error?.code) ? error.code : 'prepare',
    ...(Number.isInteger(error?.httpStatus) && error.httpStatus >= 400 && error.httpStatus <= 599
      ? { httpStatus: error.httpStatus } : {}),
  }))
  process.exitCode = 1
}
