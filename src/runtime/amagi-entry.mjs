// A separately built, lazily loaded SDK boundary keeps its dependency graph out
// of the default Hongguo/MCP bundle, including amagi's own pinned Zod version.
import { AsyncLocalStorage } from 'node:async_hooks'
import axios from '@ikenxuan/amagi/axios'
import { bilibiliFetcher } from '@ikenxuan/amagi'

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
