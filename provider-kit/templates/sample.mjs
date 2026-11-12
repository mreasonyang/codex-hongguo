// Replace these local sample records and transport with your site's API.
import { readFile } from 'node:fs/promises'
import { Readable, PassThrough } from 'node:stream'
import { filePlayback, page, providerError } from './sdk/index.mjs'

export const shows = ['sample-one', 'sample-two'].map((id, i) => ({
  id, title: 'Sample ' + (i + 1), episodes: 2, coverURL: 'https://sample.invalid/cover.png',
}))
const media = 'https://sample.invalid/clip.mp4'
export function slicePage(items, { cursor, pageSize = 1, signal } = {}) {
  signal?.throwIfAborted()
  const offset = cursor === undefined ? 0 : items.findIndex(row => row.id === cursor)
  if (offset < 0) throw providerError('NOT_FOUND')
  // One row per page exercises opaque cursors in a two-item fixture.
  const next = offset + Math.min(1, pageSize)
  return page(items.slice(offset, next), items[next]?.id ?? null)
}
export function sampleMethods(context) {
  function getSeries(id, { signal } = {}) {
    signal?.throwIfAborted()
    const series = shows.find(item => item.id === id)
    if (!series) throw providerError('NOT_FOUND')
    return series
  }
  return {
    id: context.id,
    getSeries,
    listEpisodes(id, options = {}) {
      getSeries(id, options)
      return slicePage([1, 2].map(number => ({ id: id + '/' + number, number, label: 'Episode ' + number })), options)
    },
    getCover(id, options) {
      getSeries(id, options)
      return { bytes: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=', 'base64'), mime: 'image/png' }
    },
    resolvePlayback(id, options) {
      if (!shows.some(show => [1, 2].some(n => id === show.id + '/' + n))) throw providerError('NOT_FOUND')
      options?.signal?.throwIfAborted()
      return filePlayback(media)
    },
    async fetchMedia(url, budget, _timeout, _redirects, _range, signal) {
      if (url !== media) throw providerError('NOT_FOUND')
      const bytes = await readFile(new URL('./sample.mp4', import.meta.url), { signal })
      if (bytes.length > budget) throw providerError('BUDGET')
      return { body: Readable.from([bytes]), limit: new PassThrough(), url }
    },
  }
}
