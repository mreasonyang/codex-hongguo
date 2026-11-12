import { shows, sampleMethods, slicePage } from './sample.mjs'

/** @type {import('./sdk/index.mjs').CreateProvider} */
export const createProvider = context => ({
  ...sampleMethods(context),
  listSeries({ query = '', ...options } = {}) {
    const matches = shows.filter(show => show.title.toLowerCase().includes(query.toLowerCase()))
    return slicePage(matches, options)
  },
})
