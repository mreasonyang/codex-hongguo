// A separately built, lazily loaded SDK boundary keeps its dependency graph out
// of the default Hongguo/MCP bundle, including amagi's own pinned Zod version.
import { AsyncLocalStorage } from 'node:async_hooks'
import axios from '@ikenxuan/amagi/axios'
import { bilibiliFetcher, wbi_sign } from '@ikenxuan/amagi'

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

// amagi provides the maintained WBI signer and HTTP client, but not PGC search
// or the season index. Keep those two public web operations in this same bounded
// SDK transport rather than adding a second signer or leaking requests to Axios.
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
