import { fork } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFile, cp, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { providerPattern, errorCodes } from '../../provider-kit/sdk/index.mjs'
import { dataRoot, projectRoot } from '../server/paths.mjs'
import { packageVersion } from '../runtime/distribution.mjs'
import { installedProviders, activatePackage, libraryDirectory } from '../server/providers/library.mjs'
import { isBuiltinProviderId } from '../server/providers/registry.mjs'
import { packageFile, readPackage } from '../server/providers/package.mjs'
import { stages, byteBudget } from './provider-check.mjs'

const help = `codex-hongguo provider create <directory> [--template search|link] [--id my-source]
codex-hongguo provider test <directory> [--query text]
codex-hongguo provider doctor <directory|--installed id> [--query text]
codex-hongguo provider preview <directory>
codex-hongguo provider install|update <directory>
codex-hongguo provider list
codex-hongguo provider rollback|remove <id>`
function checkId(id, { allowBuiltin = false } = {}) {
  if (typeof id !== 'string' || !providerPattern.test(id) || (!allowBuiltin && isBuiltinProviderId(id))) throw Error('PROVIDER_ID')
}
async function create(directory, template, id) {
  checkId(id)
  if (!['link', 'search'].includes(template)) throw Error('TEMPLATE')
  const kit = join(projectRoot, 'provider-kit'), assets = join(kit, 'templates')
  await mkdir(directory, { mode: 0o700 })
  try {
    const example = template === 'link' ? 'https://sample.invalid/watch/sample-one' : 'Sample'
    const manifest = { $schema: './sdk/provider.schema.json', apiVersion: 1, id, name: id, version: '1.0.0',
      entry: 'index.mjs', queryMode: template, queryHint: template === 'link' ? '输入示例链接 ' + example : '搜索 Sample',
      files: ['sample.mjs', 'sample.mp4', 'sdk/index.mjs', 'sdk/index.d.mts', 'sdk/provider.schema.json', 'sdk/LICENSE', 'sdk/NOTICE'] }
    await writeFile(join(directory, 'provider.json'), JSON.stringify(manifest, null, 2) + '\n')
    await cp(join(kit, 'sdk'), join(directory, 'sdk'), { recursive: true })
    await copyFile(join(projectRoot, 'LICENSE'), join(directory, 'sdk/LICENSE'))
    await writeFile(join(directory, 'sdk/NOTICE'), `Provider SDK from @kyun.si/codex-hongguo ${packageVersion}.\nCopyright (c) 2026 Eason Yang. AGPL-3.0-only; see LICENSE.\nSource: https://github.com/mreasonyang/codex-hongguo\n`)
    await copyFile(join(assets, template + '.mjs'), join(directory, 'index.mjs'))
    await copyFile(join(assets, 'sample.mjs'), join(directory, 'sample.mjs'))
    await copyFile(join(projectRoot, 'dist/provider-sample.mp4'), join(directory, 'sample.mp4'))
    await writeFile(join(directory, 'provider.fixture.mjs'),
      'export const query = ' + JSON.stringify(example) + '\nexport const missingQuery = "missing-example"\n')
    return { id, template, exampleQuery: example }
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
}

async function runWorker(action, directory, query) {
  const root = await mkdtemp(join(tmpdir(), 'hongguo-provider-'))
  const child = fork(new URL('./provider-worker.mjs', import.meta.url), [], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], execArgv: [], windowsHide: true,
  })
  const report = { mode: action, hostVersion: packageVersion, checkedAt: new Date().toISOString(), ok: false,
    timeBudgetMs: 45000, ...(action === 'doctor' ? { byteBudget, sampleLimit: 3 } : {}),
    stages: Object.fromEntries(stages.map(name => [name, { status: 'unverified' }])) }
  let stage = 'manifest', done = false, preview = false
  const stop = () => child.kill('SIGKILL')
  const timer = setTimeout(() => {
    report.stages[stage] = { status: 'failed', code: 'TIMEOUT' }
    stop()
  }, report.timeBudgetMs)
  // Limit provider stdout/stderr to its own process. Only fixed protocol fields
  // can enter the JSON report, including on import failures and process exits.
  child.on('message', msg => {
    if (!msg || typeof msg !== 'object') return
    if (action === 'preview' && Number.isInteger(msg.port) && msg.port > 0 && msg.port < 65536 && !preview) {
      clearTimeout(timer); preview = true
      console.log(JSON.stringify({ preview: 'http://127.0.0.1:' + msg.port, data: 'temporary' }))
    } else if (typeof msg.done === 'boolean') done = msg.done
    else if (stages.includes(msg.stage) && ['running', 'passed', 'failed', 'unverified'].includes(msg.status)) {
      stage = msg.stage
      report.stages[stage] = { status: msg.status, ...(errorCodes.includes(msg.code) ? { code: msg.code } : {}) }
      if (['catalog', 'search', 'seriesPage2'].includes(stage) && Number.isInteger(msg.itemCount) && msg.itemCount >= 0 && msg.itemCount <= 10000)
        report.stages[stage].itemCount = msg.itemCount
      if (action === 'doctor' && stage === 'media' && msg.status === 'passed' &&
          ['complete', 'hls-first-segment'].includes(msg.mediaScope)) report.mediaScope = msg.mediaScope
      const sample = msg.sampleAttempt
      if (action === 'doctor' && Number.isInteger(sample?.index) && sample.index >= 1 && sample.index <= 3 &&
          ['catalog', 'search'].includes(sample.origin) && ['selected', 'skipped'].includes(sample.outcome) &&
          (sample.outcome === 'selected' || (stages.includes(sample.stage) && errorCodes.includes(sample.code)))) {
        report.samples ??= []
        if (report.samples.length < 3 && !report.samples.some(item => item.index === sample.index))
          report.samples.push({ index: sample.index, origin: sample.origin, outcome: sample.outcome,
            ...(sample.outcome === 'skipped' ? { stage: sample.stage, code: sample.code } : {}) })
      }
      if (stage === 'manifest' && providerPattern.test(msg.identity?.id) && typeof msg.identity?.id === 'string' &&
          typeof msg.identity?.version === 'string' && /^\d+\.\d+\.\d+$/.test(msg.identity.version)) {
        report.provider = { id: msg.identity.id, version: msg.identity.version }
      }
    }
  })
  process.once('SIGINT', stop); process.once('SIGTERM', stop)
  try {
    const exit = new Promise(resolve => {
      child.once('error', () => resolve(1)); child.once('exit', resolve)
    })
    child.send({ action, directory, query, root }, error => { if (error) stop() })
    const status = await exit
    if (preview) return
    report.ok = done && status === 0
    if (!report.ok && !Object.values(report.stages).some(item => item.status === 'failed')) report.stages[stage] = { status: 'failed', code: 'LOAD_FAILED' }
    return report
  } finally {
    clearTimeout(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop)
    await rm(root, { recursive: true, force: true, maxRetries: 3 })
  }
}

async function install(root, directory, action) {
  const plugin = await readPackage(directory), { id, version } = plugin.manifest
  checkId(id)
  const library = libraryDirectory(root)
  await mkdir(library, { recursive: true, mode: 0o700 })
  if (!(await lstat(library)).isDirectory()) throw Error('LIBRARY')
  const revision = randomUUID(), destination = join(library, revision)
  await mkdir(destination, { mode: 0o700 })
  try {
    const files = new Set(['provider.json', plugin.manifest.entry.replace(/^\.\//, ''), ...(plugin.manifest.files || [])])
    for (const name of files) {
      const { file } = await packageFile(plugin.directory, name)
      const target = join(destination, name)
      await mkdir(dirname(target), { recursive: true, mode: 0o700 })
      await copyFile(file, target)
    }
    const checked = await runWorker('load', destination)
    if (!checked.ok || checked.provider?.id !== id || checked.provider.version !== version) throw Error('LOAD_FAILED')
    return activatePackage(root, action, id, revision, version)
  } catch (error) {
    await rm(destination, { recursive: true, force: true })
    throw error
  }
}

export async function providerCommand(argv) {
  const [action = 'help', ...args] = argv
  if (['help', '-h', '--help'].includes(action)) { console.log(help); return }
  const options = action === 'create' ? { template: { type: 'string', default: 'search' }, id: { type: 'string' } }
    : ['test', 'doctor'].includes(action) ? { query: { type: 'string' }, ...(action === 'doctor' ? { installed: { type: 'boolean' } } : {}) } : {}
  try {
    const { values, positionals } = parseArgs({ args, options, allowPositionals: true })
    if (positionals.length !== (action === 'list' ? 0 : 1)) throw Error('USAGE')
    const [target] = positionals, root = dataRoot()
    let result
    switch (action) {
      case 'create': result = await create(resolve(target), values.template, values.id ?? basename(resolve(target))); break
      case 'test': case 'doctor': case 'preview': {
        let directory = resolve(target)
        if (values.installed) {
          checkId(target, { allowBuiltin: true })
          const item = installedProviders(root).find(row => row.id === target)
          if (!item) throw Error('NOT_INSTALLED')
          directory = join(libraryDirectory(root), item.active)
        }
        result = await runWorker(action, directory, values.query)
        if (result && !result.ok) process.exitCode = 1
        break
      }
      case 'install': case 'update': result = await install(root, resolve(target), action); break
      case 'rollback': case 'remove':
        checkId(target, { allowBuiltin: action === 'remove' })
        result = activatePackage(root, action, target); break
      case 'list': result = { items: installedProviders(root).map(({ id, version, previousVersion }) => ({
        id, version, previousVersion, ...(isBuiltinProviderId(id) ? { code: 'PROVIDER_ID' } : {}),
      })) }; break
      default: throw Error('USAGE')
    }
    if (result) console.log(JSON.stringify(result))
  } catch (error) {
    const codes = ['USAGE', 'TEMPLATE', 'PROVIDER_ID', 'LIBRARY', 'LIBRARY_FULL', 'ALREADY_INSTALLED', 'NOT_INSTALLED',
      'NO_PREVIOUS_VERSION', 'MANIFEST', 'LOAD_FAILED', 'EEXIST', 'ENOENT', 'EACCES', 'EPERM']
    const code = [error.code, error.message].find(value => codes.includes(value)) || 'PROVIDER_COMMAND_FAILED'
    console.log(JSON.stringify({ ok: false, code }))
    process.exitCode = 1
  }
}
