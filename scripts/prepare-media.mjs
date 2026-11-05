import { ensureFfmpeg } from '../src/runtime/ffmpeg-runtime.mjs'
await ensureFfmpeg()
console.log('插件管理的播放组件已就绪')
