export function mediaErrorMessage(code?: number): string {
  switch (code) {
    case 1: return '视频加载已中止，可以重新点播'
    case 2: return '读取视频数据失败，请重新点播'
    case 3: return '播放器解码视频数据失败，可使用同窗分屏'
    case 4: return '播放器无法打开视频来源，可重新点播或使用同窗分屏'
    default: return '视频加载失败，请重新点播'
  }
}

export function waitForMetadata(video: HTMLVideoElement, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const ready = () => finish()
    const failed = () => finish(Error(mediaErrorMessage(video.error?.code)))
    const aborted = () => finish(signal.reason)
    const timer = setTimeout(() => finish(Error('等待视频元数据超时，请重新点播')), 30000)
    function finish(error?: unknown) {
      clearTimeout(timer)
      video.removeEventListener('loadedmetadata', ready)
      video.removeEventListener('error', failed)
      signal.removeEventListener('abort', aborted)
      if (error !== undefined) reject(error)
      else resolve()
    }
    video.addEventListener('loadedmetadata', ready)
    video.addEventListener('error', failed)
    signal.addEventListener('abort', aborted)
    if (signal.aborted) aborted()
  })
}
