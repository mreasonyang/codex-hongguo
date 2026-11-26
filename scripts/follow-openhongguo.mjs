import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareVersions, parseVersion } from '../src/runtime/version.mjs'
import { archiveURL, downloadArchive } from './openhongguo-archive.mjs'

const upstream = 'beilunyang/openhongguo'
const repository = 'https://github.com/' + upstream
const manifestPath = 'third_party/openhongguo/source.json'
const sha = /^[a-f0-9]{40}$/
const review = reason => ({ action: 'review', reason })
const stable = version => parseVersion(version)?.beta === null
const json = async path => JSON.parse(await readFile(path, 'utf8'))

function api(path, options = []) {
  const result = execFileSync('gh', ['api', '--hostname', 'github.com', ...options, 'repos/' + upstream + '/' + path],
    { encoding: 'utf8', maxBuffer: 24 * 1024 * 1024 })
  return JSON.parse(result)
}

function declaresBreak(message) {
  const text = message.replace(/\b(?:non[- ]breaking|no breaking changes?)\b|无破坏性变更/gi, '')
  return /\bbreaking(?:[ -]changes?\b|:|\s*$)|backwards?[ -]incompatible|^\w+(?:\([^\n)]+\))?!:|破坏性(?:变更|更新|更改|变化)|不(?:再)?(?:向[后下])?兼容/im.test(text)
}

export function releasePolicy(current, release) {
  const tag = release.tag_name
  if (!stable(current) || !tag?.startsWith('v') || !stable(tag.slice(1)) || release.draft || release.prerelease)
    return review('上游标签或当前固定版本不属于支持的正式版本。')
  const version = tag.slice(1)
  if (compareVersions(version, current) <= 0) return { action: 'current' }
  const [major, minor] = parseVersion(current).core
  const next = parseVersion(version).core
  if (next[0] !== major || (major === 0 && next[1] !== minor))
    return review('跨主版本或 0.x 次版本，需要检查兼容性。')
  if (declaresBreak((release.name || '') + '\n' + (release.body || '')))
    return review('上游发布说明声明了破坏性变更。')
  return { action: 'candidate' }
}

export function changePolicy(comparison, before, after) {
  if (comparison.status !== 'ahead' || comparison.merge_base_commit?.sha !== before ||
      comparison.commits?.at(-1)?.sha !== after || comparison.commits.length !== comparison.ahead_by ||
      !Array.isArray(comparison.files) || comparison.files.length >= 300)
    return review('提交历史已分叉，或 GitHub 返回的变更范围不完整。')
  if (comparison.commits.some(entry => declaresBreak(entry.commit.message)))
    return review('上游提交声明了破坏性变更。')
  const paths = comparison.files.flatMap(file => [file.filename, file.previous_filename].filter(Boolean))
  if (paths.some(path => /^(?:signer\/|internal\/protocol\/sign\/)|(?:^|\/)(?:attestation|anti[-_]?abuse|anti[-_]?bot)(?:[./_-]|$)/i.test(path)))
    return review('上游调整了请求签名或设备校验，需要人工审阅。')
  if (paths.some(path => /^(?:bindings\/node\/)?(?:GO_)?LICEN[CS]E(?:\..*)?$/i.test(path)))
    return review('分发包附带的上游许可有改动，需要核对声明。')
  return { action: 'candidate' }
}

function inspect(pin, readAPI) {
  if (pin.repository !== repository || !sha.test(pin.revision) || pin.version !== pin.upstreamVersion)
    throw Error('Invalid existing openhongguo pin')
  const release = readAPI('releases/latest')
  const tag = release.tag_name
  const decision = releasePolicy(pin.version, release)
  if (decision.action !== 'candidate') return { ...decision, tag }

  // Release notes can declare an incompatibility even when the newest patch omits it.
  const releases = readAPI('releases?per_page=100', ['--paginate', '--slurp']).flat()
  for (const entry of releases) {
    const version = entry.tag_name?.slice(1)
    if (entry.draft || entry.prerelease || !entry.tag_name?.startsWith('v') || !stable(version)) continue
    if (compareVersions(version, pin.version) > 0 && compareVersions(version, tag.slice(1)) <= 0) {
      const step = releasePolicy(pin.version, entry)
      if (step.action === 'review') return { ...step, tag: entry.tag_name }
    }
  }
  let { object } = readAPI('git/ref/tags/' + tag)
  while (object.type === 'tag' && sha.test(object.sha)) object = readAPI('git/tags/' + object.sha).object
  if (object.type !== 'commit' || !sha.test(object.sha)) throw Error('Upstream release tag does not identify a commit')
  const revision = object.sha
  const comparison = readAPI('compare/' + pin.revision + '...' + revision)
  const changes = changePolicy(comparison, pin.revision, revision)
  if (changes.action !== 'candidate') return { ...changes, tag }
  const tree = readAPI('git/commits/' + revision).tree.sha
  if (!sha.test(tree)) throw Error('Invalid upstream source tree')
  return { action: 'candidate', tag, revision, tree }
}

export async function planUpdate(pin, { readAPI = api, prepare = false, download = downloadArchive } = {}) {
  const plan = inspect(pin, readAPI)
  if (plan.action !== 'candidate' || !prepare) return plan
  const version = plan.tag.slice(1)
  const sourceSHA256 = createHash('sha256').update(await download(plan.revision)).digest('hex')
  return { ...plan, manifest: { ...pin, version, upstreamVersion: version, revision: plan.revision,
    sourceTree: plan.tree, sourceSHA256, releaseURL: repository + '/releases/tag/' + plan.tag,
    sourceURL: repository + '/tree/' + plan.revision, archiveURL: archiveURL(plan.revision) } }
}

async function main() {
  const flags = process.argv.slice(2)
  if (flags.length && !(flags.length === 1 && flags[0] === '--prepare')) throw Error('Expected no arguments or --prepare')
  const pin = await json(manifestPath)
  const plan = await planUpdate(pin, { prepare: flags.length === 1 })
  if (plan.manifest) await writeFile(manifestPath, JSON.stringify(plan.manifest, null, 2) + '\n')
  // These fields are also consumed by shell steps. Only emit validated tags and fixed action names.
  const tag = plan.tag?.startsWith('v') && stable(plan.tag.slice(1)) ? plan.tag : ''
  const summary = ['openhongguo v' + pin.version, tag, plan.action, plan.reason].filter(Boolean).join(' · ')
  console.log(summary)
  let report = summary
  if (plan.action === 'review') {
    const target = tag ? `[${tag}](${repository}/releases/tag/${tag})` : '上游版本'
    report = `**等待人工审阅，本次跳过发布。**\n\n项目当前固定 v${pin.version}，本次检查的目标为 ${target}。${plan.reason}`
    if (process.env.GITHUB_ACTIONS === 'true')
      console.log('::warning title=openhongguo 更新待审::' + [tag, plan.reason].filter(Boolean).join(' · '))
  }
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, report + '\n')
  if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, 'action=' + plan.action + '\ntag=' + tag + '\n')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await main()
