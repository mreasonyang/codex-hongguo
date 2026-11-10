// A separately built, lazily loaded SDK boundary keeps its dependency graph out
// of the default Hongguo/MCP bundle, including amagi's own pinned Zod version.
import { AsyncLocalStorage } from 'node:async_hooks'
import axios from '@ikenxuan/amagi/axios'
import { bilibiliFetcher, wbi_sign, av2bv } from '@ikenxuan/amagi'

// This Axios instance belongs to the separately bundled SDK. Its native account
// checks and WBI signer use default Axios instead of requestConfig.adapter.
// Bind every one of those requests to the current caller's bounded transport.
// AsyncLocalStorage keeps concurrent providers/accounts independent; an SDK
// request without a bound transport fails rather than using native HTTP.
const transports = new AsyncLocalStorage()
axios.interceptors.request.use(config => {
  const adapter = transports.getStore()
  if (!adapter) throw Error('SDK transport is unavailable')
  config.adapter = adapter
  return config
})
export const sdk = Object.fromEntries(Object.entries(bilibiliFetcher).map(([name, method]) => [
  name, (options, cookie, config) => {
    if (typeof config?.adapter !== 'function') throw Error('SDK transport is required')
    return transports.run(config.adapter, () => method(options, cookie, config))
  },
]))

// amagi provides the maintained WBI signer and HTTP client. Discovery operations
// missing from its fetcher share this bounded transport and signer too.
sdk.fetchBangumiSearch = (options, cookie, config) => transports.run(config.adapter, async () => {
  const url = new URL('https://api.bilibili.com/x/web-interface/wbi/search/type')
  url.search = new URLSearchParams({ search_type: 'media_bangumi', keyword: options.keyword, page: String(options.page) })
  url.search += await wbi_sign(url, cookie)
  return { success: true, data: (await axios.get(url.href, config)).data }
})
sdk.fetchBangumiIndex = (options, _cookie, config) => transports.run(config.adapter, async () => {
  const url = new URL('https://api.bilibili.com/pgc/season/index/result')
  url.search = new URLSearchParams({ season_type: '1', type: '1', order: '3', sort: '0',
    page: String(options.page), pagesize: String(options.pageSize) })
  return { success: true, data: (await axios.get(url.href, config)).data }
})

// Ordinary videos use the same signer and bounded transport as PGC discovery.
sdk.av2bv = av2bv
sdk.fetchVideoSearch = (options, cookie, config) => transports.run(config.adapter, async () => {
  const url = new URL('https://api.bilibili.com/x/web-interface/wbi/search/type')
  url.search = new URLSearchParams({ search_type: 'video', keyword: options.keyword, page: String(options.page),
    ...(options.category && options.category !== 'all' ? { tids: options.category } : {}) })
  url.search += await wbi_sign(url, cookie)
  return { success: true, data: (await axios.get(url.href, config)).data }
})
sdk.fetchVideoIndex = (options, _cookie, config) => transports.run(config.adapter, async () => {
  const regional = options.category && options.category !== 'all'
  const url = new URL('https://api.bilibili.com/x/web-interface/' + (regional ? 'ranking/v2' : 'popular'))
  url.search = new URLSearchParams(regional ? { rid: options.category, type: 'all' }
    : { pn: String(options.page), ps: String(options.pageSize) })
  return { success: true, data: (await axios.get(url.href, config)).data }
})
