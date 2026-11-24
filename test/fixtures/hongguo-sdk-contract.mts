import { createClient } from '../../dist/vendor/openhongguo/index.js'

// Compiled, never executed. Exercise the calls and result fields consumed by HongguoSource.
export async function adapterContract(profile: string, id: string, cursor: string, pageSize: number) {
  const client = await createClient({ profile, timeoutMs: 10000, retryAttempts: 2, deviceResets: 2 })
  const pages = [
    await client.discover({ cursor }),
    await client.search('fixture', { cursor, pageSize, filters: ['content_type_short_play'] }),
  ]
  for (const page of pages) {
    page.has_more satisfies boolean
    page.cursor satisfies string | undefined
    for (const row of [...page.items, await client.getSeries(id)]) {
      row.id satisfies string
      row.title satisfies string
      row.cover_url satisfies string | undefined
      row.description satisfies string | undefined
      row.episode_count satisfies number | undefined
    }
  }
  const episodes = await client.listEpisodes(id, { cursor, pageSize })
  for (const item of episodes.items) {
    item.id satisfies string
    item.number satisfies number
    item.title satisfies string | undefined
    item.playable satisfies boolean | undefined
  }
  const { playback } = await client.resolvePlayback(id)
  for (const stream of playback.streams) {
    stream.url satisfies string | undefined
    stream.codec satisfies string | undefined
  }
}
