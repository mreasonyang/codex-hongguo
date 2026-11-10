import Hls, {
  LoadStats,
  type Loader,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
} from 'hls.js'
import { call } from './api'
import { dashStream } from './dash-stream'

// This origin is a playlist namespace only. Every request terminates in the custom MCP loader.
const base = 'https://hongguo.invalid/'
export function panelStream(
  video: HTMLVideoElement,
  episodeId: string,
  stream: string,
  manifest: string,
  fail: (reason: string) => void,
  ended: () => void,
  options?: { format?: 'dash' | 'hls'; startPosition?: number },
) {
  if (options?.format === 'dash') return dashStream(video, episodeId, stream, manifest, fail, ended, options.startPosition)
  if (!Hls.isSupported()) throw Error('当前面板不支持分段解码，可使用同窗分屏')
  let initialManifest = true
  class PanelLoader implements Loader<LoaderContext> {
    context: LoaderContext | null = null
    stats = new LoadStats()
    abort() {
      this.stats.aborted = true
    }
    destroy() {
      this.abort()
    }
    load(ctx: LoaderContext, _config: LoaderConfiguration, cb: LoaderCallbacks<LoaderContext>) {
      this.context = ctx
      this.stats.loading.start = performance.now()
      const receive = async () => {
        const asset = ctx.url.slice(base.length)
        if (!ctx.url.startsWith(base)) throw Error('无效媒体来源')
        if (asset === 'index.m3u8') {
          if (initialManifest) { initialManifest = false; return manifest }
          return (await call<{ manifest: string }>('read_panel_manifest', { episodeId, stream }, 8000)).manifest
        }
        let offset = 0,
          buffer: Uint8Array<ArrayBuffer> | undefined
        do {
          const part = await call<{ size: number; bytes: string }>(
            'read_panel_chunk',
            { episodeId, stream, asset, offset },
            8000,
          )
          if (this.stats.aborted) return
          if (!Number.isSafeInteger(part.size) || part.size < 1 || part.size > 32 * 1024 * 1024)
            throw Error('分段长度无效')
          buffer ??= new Uint8Array(part.size)
          const raw = atob(part.bytes)
          if (part.size !== buffer.length || !raw.length || offset + raw.length > part.size)
            throw Error('分段不完整')
          for (let i = 0; i < raw.length; i++) buffer[offset + i] = raw.charCodeAt(i)
          offset += raw.length
        } while (offset < buffer.length)
        return buffer.buffer
      }
      void receive()
        .then((data) => {
          if (this.stats.aborted || data === undefined) return
          this.stats.loading.first = this.stats.loading.end = performance.now()
          this.stats.loaded = this.stats.total = typeof data === 'string' ? data.length : data.byteLength
          cb.onSuccess({ url: ctx.url, data }, this.stats, ctx, null)
        })
        .catch(() => {
          if (!this.stats.aborted) cb.onError({ code: 0, text: '侧栏分段读取失败' }, ctx, null, this.stats)
        })
    }
  }
  const hls = new Hls({
    loader: PanelLoader,
    enableWorker: false,
    startPosition: options?.format === 'hls' ? options.startPosition || 0 : 0,
    maxBufferLength: 16,
    maxMaxBufferLength: 24,
    backBufferLength: 12,
  })
  // hls.js also reports the VOD ending when MSE stalls on the final frame.
  hls.on(Hls.Events.MEDIA_ENDED, ended)
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (!data.fatal) return
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR) fail('侧栏分段读取失败，请重新点播')
    else fail('侧栏无法处理视频分段，可使用同窗分屏')
  })
  const blocked = (event: SecurityPolicyViolationEvent) => {
    if (event.disposition === 'enforce' && event.effectiveDirective === 'media-src' &&
        (event.blockedURI === 'blob' || event.blockedURI.startsWith('blob:'))) {
      fail('桌面安全策略阻止了侧栏载入本地视频')
    }
  }
  const close = () => {
    document.removeEventListener('securitypolicyviolation', blocked)
    hls.destroy()
  }
  document.addEventListener('securitypolicyviolation', blocked)
  try {
    hls.loadSource(base + 'index.m3u8')
    hls.attachMedia(video)
  } catch (error) {
    close()
    throw error
  }
  return close
}
