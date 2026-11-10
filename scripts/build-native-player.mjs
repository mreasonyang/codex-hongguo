import { mkdir, writeFile, cp, readFile, readdir } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { resolve, join } from 'node:path'

// Non-macOS packages retain the existing panel/browser player. Native builds
// are produced on macOS and may be collected by the release packaging job.
if (process.platform==='darwin') {
  const root=resolve('native/player')
  for (const arch of ['arm64','amd64']) {
    const folder=join('dist/native','darwin-'+(arch==='amd64'?'x64':arch),'HongguoPlayer.app/Contents')
    await mkdir(join(folder,'MacOS'),{recursive:true})
    const target=resolve(folder,'MacOS/HongguoPlayer')
    const build=spawnSync('go',['build','-trimpath','-ldflags=-s -w -buildid=','-o',target,'.'],{
      cwd:root,env:{...process.env,GOOS:'darwin',GOARCH:arch,CGO_ENABLED:'1'},stdio:'inherit',timeout:180000,
    })
    if(build.status!==0)throw Error('原生播放器 '+arch+' 构建失败')
    await writeFile(join(folder,'Info.plist'),`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>HongguoPlayer</string><key>CFBundleIdentifier</key><string>si.kyun.codex-hongguo.player</string><key>CFBundleName</key><string>HongguoPlayer</string><key>CFBundleDisplayName</key><string>红果播放器</string><key>CFBundlePackageType</key><string>APPL</string><key>LSUIElement</key><true/><key>LSMinimumSystemVersion</key><string>14.0</string><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`)
    const signed=spawnSync('codesign',['--force','--sign','-',resolve(folder,'..')],{stdio:'ignore',timeout:30000})
    if(signed.status!==0)throw Error('原生播放器签名失败')
  }
  const modules=spawnSync('go',['list','-m','-json','all'],{cwd:root,encoding:'utf8',timeout:60000})
  if(modules.status!==0)throw Error('无法读取原生依赖许可清单')
  const rows=JSON.parse('['+modules.stdout.trim().replace(/}\s*\{/g,'},{')+']')
  for(const mod of rows.filter(m=>!m.Main&&m.Dir)) {
    const dest=join('dist/native/licenses',mod.Path.replaceAll('/','-'))
    await mkdir(dest,{recursive:true})
    for(const file of await readdir(mod.Dir))if(/^(LICENSE|COPYING|NOTICE|OFL)(\.|$)/i.test(file))await cp(join(mod.Dir,file),join(dest,file))
  }
  const mygo=rows.find(m=>m.Path==='github.com/egoist/mygo')
  if(mygo) {
    async function licenses(dir,base='') {
      for(const f of await readdir(dir,{withFileTypes:true})) {
        const next=join(dir,f.name), rel=join(base,f.name)
        if(f.isDirectory())await licenses(next,rel)
        else if(/^(LICENSE|COPYING|NOTICE|OFL)(\.|$)/i.test(f.name)) {
          const dest=join('dist/native/licenses/mygo-assets',rel);await mkdir(resolve(dest,'..'),{recursive:true});await writeFile(dest,await readFile(next))
        }
      }
    }
    await licenses(join(mygo.Dir,'assets')).catch(error=>{if(error.code!=='ENOENT')throw error})
  }
}
