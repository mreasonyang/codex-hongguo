const pattern = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})(?:-beta\.([1-9]\d*))?$/

export function parseVersion(value) {
  const match = typeof value === 'string' && pattern.exec(value)
  if (!match || (match[4] && !Number.isSafeInteger(Number(match[4])))) return null
  return { core: match.slice(1, 4).map(Number), beta: match[4] ? Number(match[4]) : null }
}
export const isVersion = value => !!parseVersion(value)
export function releaseChannel(value) {
  const parsed = parseVersion(value)
  if (!parsed) throw Error('Invalid release version')
  return parsed.beta === null ? 'latest' : 'beta'
}
export function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right)
  if (!a || !b) throw Error('Invalid release version')
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return Math.sign(a.core[i] - b.core[i])
  if (a.beta === b.beta) return 0
  if (a.beta === null) return 1
  if (b.beta === null) return -1
  return Math.sign(a.beta - b.beta)
}
export function nextBetaVersion(value) {
  const parsed = parseVersion(value)
  if (!parsed) throw Error('Invalid release version')
  if (parsed.beta !== null) {
    if (!Number.isSafeInteger(parsed.beta + 1)) throw Error('Beta sequence exhausted')
    return parsed.core.join('.') + '-beta.' + (parsed.beta + 1)
  }
  if (parsed.core[2] === 999) throw Error('Patch segment exhausted; select the next base version explicitly')
  parsed.core[2]++
  return parsed.core.join('.') + '-beta.1'
}
