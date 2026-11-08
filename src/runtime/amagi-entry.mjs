// A separately built, lazily loaded SDK boundary keeps its dependency graph out
// of the default Hongguo/MCP bundle, including amagi's own pinned Zod version.
import { bilibiliFetcher } from '@ikenxuan/amagi'
export const sdk = bilibiliFetcher
