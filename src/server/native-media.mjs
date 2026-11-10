import { createReadStream, statSync } from 'node:fs'
import { join } from 'node:path'
import { PlayerError } from './errors.mjs'
import { range } from './browser.mjs'

const mediaName = /^(?:video|audio)-(?:init\.mp4|\d{5}\.m4s)$/
/** Adapt our bounded, authorized DASH cache to AVFoundation's fMP4 HLS input. */
export function nativePlaylists(manifest) {
  const data = JSON.parse(manifest)
  if (data.version !== 1 || !Array.isArray(data.tracks) || data.tracks.length !== 2) throw new PlayerError('播放分段索引无效')
  const tracks = data.tracks.map(track => {
    if (!mediaName.test(track.initialization) || !track.segments?.length ||
        !track.segments.every(s => mediaName.test(s.asset) && Number.isFinite(s.duration) && s.duration > 0 && s.duration < 120))
      throw new PlayerError('播放分段索引无效')
    const codec = /codecs="([\w.]+)"/.exec(track.mime)?.[1]
    if (!codec) throw new PlayerError('播放分段索引无效')
    const name = track.mime.startsWith('video/') ? 'video' : 'audio'
    const playlist = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-PLAYLIST-TYPE:VOD',
      '#EXT-X-TARGETDURATION:' + Math.ceil(Math.max(...track.segments.map(s => s.duration))),
      '#EXT-X-MEDIA-SEQUENCE:0', '#EXT-X-MAP:URI="' + track.initialization + '"',
      ...track.segments.flatMap(s => ['#EXTINF:' + s.duration.toFixed(6) + ',', s.asset]), '#EXT-X-ENDLIST', ''].join('\n')
    return { name, codec, playlist }
  })
  if (new Set(tracks.map(t => t.name)).size !== 2) throw new PlayerError('播放分段索引无效')
  return new Map([
    ['master.m3u8', ['#EXTM3U', '#EXT-X-VERSION:7',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="main",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"',
      '#EXT-X-STREAM-INF:BANDWIDTH=24000000,CODECS="' + tracks.map(t => t.codec).join(',') + '",AUDIO="audio"', 'video.m3u8', ''].join('\n')],
    ...tracks.map(t => [t.name + '.m3u8', t.playlist]),
  ])
}

export async function serveNativeMedia(catalog, media, asset, req, res) {
  let file
  if (media.format === 'dash') {
    const remote = catalog.panelMedia.remote
    const entry = remote.entry(media.episodeId, media.stream)
    if (asset.endsWith('.m3u8')) {
      const text = nativePlaylists(entry.manifest).get(asset)
      if (!text) throw new PlayerError('找不到播放分段', 404)
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl')
      return res.end(req.method === 'HEAD' ? undefined : text)
    }
    if (!mediaName.test(asset)) throw new PlayerError('找不到播放分段', 404)
    await remote.asset(entry, asset)
    remote.valid(entry)
    file = join(entry.dir, asset)
  } else {
    if (asset !== 'video.mp4') throw new PlayerError('找不到播放分段', 404)
    catalog.cache.hold(media.episodeId)
    file = catalog.cache.path(media.episodeId)
  }
  const size = statSync(file, { throwIfNoEntry: false })?.size
  if (!size) throw new PlayerError('播放缓存已失效，请重新打开播放器', 404)
  const part = range(req.headers.range, size)
  if (part === false) { res.writeHead(416, { 'Content-Range': 'bytes */' + size }); return res.end() }
  const [start, end] = part || [0, size - 1]
  res.setHeader('Content-Type', asset.startsWith('audio-') ? 'audio/mp4' : 'video/mp4')
  res.setHeader('Accept-Ranges', 'bytes')
  if (part) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
  res.writeHead(part ? 206 : 200, { 'Content-Length': end - start + 1 })
  if (req.method === 'HEAD') return res.end()
  const stream = createReadStream(file, { start, end })
  stream.on('error', () => res.destroy())
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}
