import { readFile } from 'node:fs/promises'
import { createProvider as sample } from './index.mjs'
import { providerError } from './sdk/index.mjs'

export function createProvider(context) {
  return {
    ...sample(context),
    resolvePlayback() {
      return {
        candidates: [{ kind: 'hls', url: 'https://fixture.invalid/master.m3u8' }],
        async fetchMedia(url) {
          const file = new URL(url).pathname.substring(1)
          if (file === 'missing-second.ts') throw providerError('NOT_FOUND')
          const bytes = await readFile(new URL(file, import.meta.url)).catch(error => {
            if (error.code === 'ENOENT') throw providerError('MEDIA_EXPIRED')
            throw error
          })
          return { body: new Response(bytes).body, url: String(url) }
        },
      }
    },
  }
}
