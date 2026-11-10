import { build } from 'esbuild'
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
await import('./build-launcher.mjs')
await import('./build-native-player.mjs')
await import('./prepare-amagi-source.mjs')
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '--noEmit'], { stdio: 'inherit' })
await Promise.all([
  build({
    entryPoints: ['src/server/index.mjs', 'src/hooks/write.mjs', 'src/setup/check.mjs', 'src/cli/main.mjs'],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22.16',
    outdir: 'dist',
    outbase: 'src',
    outExtension: { '.js': '.mjs' },
    banner: { js: "import {createRequire as __cr} from 'node:module';const require=__cr(import.meta.url);" },
    minify: true,
    legalComments: 'eof',
  }),
  cp('node_modules/openhongguo', 'dist/vendor/openhongguo', { recursive: true }),
  build({ entryPoints: ['src/runtime/amagi-entry.mjs'], bundle: true, platform: 'node', format: 'esm',
    target: 'node22.16', outfile: 'dist/vendor/amagi/index.mjs', minify: true, legalComments: 'eof',
    banner: { js: "import {createRequire as __cr} from 'node:module';const require=__cr(import.meta.url);" } }),
  mkdir('dist/ui', { recursive: true }),
])
const ui = await build({
  entryPoints: ['src/ui/player.ts'],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2022',
  minify: true,
  write: false,
  legalComments: 'eof',
})
const css = await readFile('src/ui/style.css', 'utf8')
const html = (await readFile('src/ui/player.html', 'utf8'))
  .replace('/*STYLE*/', () => css)
  .replace('/*SCRIPT*/', () => ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script'))
await writeFile('dist/ui/player.html', html)
