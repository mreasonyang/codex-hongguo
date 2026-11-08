# npm 分发与发布

面向维护者。版本以源码根目录 `package.json` 为准；包名配置为 `@kyun.si/codex-hongguo`。默认市场由安装器在本机生成，仓库市场 `mreasonyang/codex-hongguo` 仅用于显式指定的 Git 来源。实际发布状态见 README 的发布提示，并以 npm registry 回读为准。

## 安装、更新与卸载

首发完成后的用户入口：

```sh
npx "@kyun.si/codex-hongguo@latest" setup
npx "@kyun.si/codex-hongguo@latest" update
npx "@kyun.si/codex-hongguo@latest" uninstall
```

命令检查 Node、npm 和 Codex CLI，自动准备播放组件，并将小型 npm 市场索引写入用户数据目录的 `managed-marketplace/<安装器版本>/.agents/plugins/marketplace.json`。Codex 用本机目录注册 `hongguo-local`，然后从 npm 下载插件，默认流程不调用 Git。索引固定为与安装器一致的 npm 版本；使用 `npx ...@latest update` 更新时，新版安装器会注册新目录和新版索引，避免沿用旧市场快照。索引放在持久数据目录，不依赖 npx 临时缓存。仓库中的 `.agents/plugins/marketplace.json` 继续为显式 Git 来源维护确定版本；插件标识始终是 `codex-hongguo@hongguo-local`。

两个命令均支持 `--dry-run` 和 `--marketplace owner/repo|本地目录`。预览仍会检查依赖，但不调用 Codex 修改注册。来源参数只接受仓库 slug 或现有本地目录；显式 Git 来源需要 Git。后续操作省略该参数时会选择默认本机 npm 索引，因此自定义和离线来源每次都应显式提供。

`uninstall` 自动查找 Codex CLI 并移除插件；本机自管市场同时移除注册，随后删除播放组件、观看进度、设置、全部视频缓存、设备档案和 `managed-marketplace/` 索引。不下载或运行播放组件，也不检查 npm。支持 `--dry-run` 预览，不接受 `--marketplace`。卸载前关闭播放器面板，完成后打开新聊天。

组件目录归属通过固定命名空间确定。默认使用插件专用缓存下的 `runtime/ffmpeg/`；自定义缓存时使用 `<HONGGUO_RUNTIME_DIR>/codex-hongguo/runtime/ffmpeg/`。卸载清空这个专属目录，包括损坏程序、缺失或损坏的回执、未知旧版本、安装锁和下载残片；同时删除默认用户数据目录。目录内及目录本身的符号链接只删除链接，不跟随目标；目录外的系统或自配 FFmpeg、自定义目录的无关内容不删除。自定义 `HONGGUO_DATA_DIR` 时删除插件的 SQLite 及附属文件、`media/`、`panel-media/`、`device/`。完整性校验用于安装和运行，不作为留下组件文件的理由。无法清理时返回失败并提示重试，重复卸载可以继续清理。

如果旧安装来自 ZIP，向导只替换同名市场并重新安装；失败会尝试恢复旧来源和插件注册。默认流程从旧 Git 来源迁移时，失败后提示重试本机安装，不重新拉取旧 Git 来源。观看数据不移动、不清理。迁移前关闭播放器，完成后打开新对话并审查 Hooks。安装器不收集或输出账号凭据，认证由现有 Codex/npm 客户端处理；它不写入 Hook 信任，也不转发宿主原始诊断输出。

`doctor` 输出播放环境元数据和固定的 Hooks 人工核对提示，不读取或判断授权状态。授权由用户直接在 Codex「设置 → Hooks」核对。

## 运行环境与包内容

npm 包的 `os` 为 darwin/linux/win32，Windows 需要 x64 或 ARM64 Node；ARM64 系统需要 Windows 11 和插件 >=0.0.30。Windows PowerShell 使用 `npx.cmd "@kyun.si/codex-hongguo@latest" setup`，详见 [Windows 支持](windows-support.md)。三平台的自动化安装验证与桌面播放观察分别记录。需要外部 Node.js >=22.16（含 npm）和 Codex CLI。播放组件由安装器自动从原始发行者下载到用户缓存，校验固定的 SHA-256 后使用；不需要全局安装 FFmpeg。包内提供 JavaScript 依赖、播放器、SDK/WASM、播放组件清单和许可说明。

MCP 使用同名的 `bin/run-node` / Windows `bin/run-node.exe` 入口，Hooks 按平台调用同一启动器。两者都检查 Node 版本及 `node:sqlite`；POSIX 保留 PATH、Homebrew、Volta、nvm、mise、fnm 查找，Windows 支持 PATH、常见 Node、Volta、nvm-windows 和 Scoop 位置。源码构建需 Go >=1.25，发行包使用者无需安装 Go。FFmpeg/Codex 通过 `src/runtime/executables.mjs` 查找，显式覆盖项见 [CONTRIBUTING](../CONTRIBUTING.md#运行环境与诊断)。覆盖值必须在实际宿主子进程的环境中可见。

源码根目录 `package.json` 的 `private: true` 用于阻止误发开发目录，公开包在 `release/npm/codex-hongguo/` 单独生成，包含：

- `.codex-plugin/plugin.json`、`.mcp.json`、`hooks/` 和 `skills/`。
- `assets/` 中的原创插件图标，兼容清单通过 `composerIcon` 和 `logo` 引用；便携源码清单使用相同资源。
- `bin/`、预构建的 `dist/cli/`、`dist/server/`、`dist/hooks/`、`dist/setup/` 和 `dist/ui/`。
- `dist/vendor/openhongguo/`，包括 WASM。
- 截取后的中英文 README、项目 MIT 许可证 `LICENSE` 和 `licenses/` 第三方许可声明。

README 的界面截图以无损 WebP 留在源码仓库中，npm 包和离线 ZIP 均不携带截图。
打包后的中英文 README 使用与发行版本标签绑定的 GitHub 图片地址，保留截图展示。
安装验收检查安装目录中没有截图，且两份 README 的图片链接均指向该版本。

播放组件下载的总时限为 30 分钟，最多三次尝试共用该时限；等待另一安装完成的时限为 32 分钟。
安装过程每 30 秒更新锁的时间，避免旧版本将慢速下载误判为废弃安装。
环境检查的外层时限覆盖等待、下载与解压校验，不会在原先的 15 秒处提前结束。

包不声明安装依赖或生命周期脚本，也不包含本机绝对路径、观看媒体、设备档案、测试数据和凭据。便携清单保留在源码，安装包采用已验证的兼容清单。项目采用 [MIT 许可证](../LICENSE)，npm 元数据使用 `MIT`；第三方依赖仍按各自许可分发。

## 产物与验收

```sh
npm ci
npm test
npm run package
npm run verify:install
```

| 产物 | 用途 |
| --- | --- |
| `release/kyun.si-codex-hongguo-<版本>.tgz` | 待发布的完整 npm 包，发布脚本直接上传此文件。 |
| `release/codex-hongguo-<版本>.zip` | 相同插件产物组成的离线本地市场。 |
| `release/marketplace/.agents/plugins/marketplace.json` | 待采用的版本索引，npm 发布核实成功后复制到仓库。 |
| `release/package-metadata.json` | 包名文件、版本和大小等打包元数据。 |
| `release/verification.json` | 本机为单平台安装回执；发布 CI 合并三平台回执，绑定同一源码与 tgz 哈希。 |

隔离验证创建本地 HTTPS npm 测试仓库及临时 CA，在临时 HOME/Codex 配置下执行真实 npm exec/npx 和 Codex 原生 npm 下载；生产 TLS 策略不变。从空白 HOME/Codex 配置全新安装，检查进度、设置、宿主工具、两个 UI 资源、真实片库/分集、三个待信任 Hooks，以及卸载删除全部本地数据。

额外验证真实分集解码时运行：

```sh
node scripts/verify-install.mjs --playback
```

`--playback` 取回安装副本提供的初始化段与媒体段，用 FFmpeg 解码。它不等同于桌面视频控件实播；回执的 `desktopPlaybackObserved` 固定为 false。公开 npm/GitHub 的真实安装链路、桌面画面与自然回合自动暂停、Linux 实机需分别验收，不能从本地测试仓库的成功推导为已上线。

重新打包会使旧回执失效，需要重新安装验证。已发布的 npm 名称/版本不能覆盖，修改已发布内容应递增版本；见 [npm publish 文档](https://docs.npmjs.com/cli/v11/commands/npm-publish/)。

## 版本与 CI 发布

普通提交、PR 和本地候选安装不触发 npm 发布。一个待发布版本可以包含多次修改；正式版沿用三段数字（每段 0–999）；测试版使用下一正式版本加 `-beta.N`，N 从 1 开始。构建、测试和本地安装都不自动改版本号。已发布版本不能覆盖。

发布由 `.github/workflows/publish.yml` 负责：

1. 维护者确认发布后，为已提交到 `main` 的版本打标签，例如源码为 `0.0.34` 时使用 `v0.0.34`，再推送该标签。标签版本必须与该提交的 `package.json` 一致，且提交必须属于 `main` 历史。
2. CI 固定标签指向的提交，只构建、打包一次，记录源码 SHA、tgz SHA-256/SHA-512、离线 ZIP 与待发布索引的哈希。
3. macOS、Linux、Windows 下载同一份构建和 tgz，分别跑回归及原生 npm 隔离安装。三个回执必须对应同一源码与包哈希；Windows 仍验证 PowerShell 5.1/7，不跳过平台检查。
4. 三平台通过后生成发布预览。正式发布 job 通过 OIDC 上传已经验收的 tgz，不再安装项目依赖、构建或打包。
5. 回读 npm registry，确认公开包 SHA-512 与验收包一致，才记录发布成功。随后单独检出最新 `main`，更新市场索引及 `docs/releases/npm-<版本>.json`，并生成对应标签的 GitHub Release 说明。更新索引不会降低已发布版本。

确认正式发布后执行，版本需与源码一致：

```sh
git tag v0.0.34
git push origin v0.0.34
```

日常 `ci.yml` 也使用一次构建、三平台共享产物，但不发布。验证完整发布链路时，在 GitHub Actions 中手动运行 Publish，保持 `publish=false`，可留空 `tag` 验证所选提交。该预演会生成合并回执和发布计划，跳过 npm 上传、索引提交和 GitHub Release 创建。

失败后优先在同一工作流中仅重跑失败的 job，复用原有验收包；也可以手动选择既有标签并明确勾选 `publish=true`。若 npm 已存在该版本，只有完整性完全一致才可继续收尾；若重新构建的内容不同，流程失败，不覆盖、不推进索引。不得移动已经发布的标签来替换内容。

npm 上传成功与公开元数据可见可能相隔数分钟。发布脚本最多等待十分钟回读版本、完整性和渠道指向；若仍超时，先检查 registry，再重跑原工作流的失败 job。仅因回读延迟不需要递增版本或再次上传。

## npm 受信任发布者

在 npm 包设置中为 `mreasonyang/codex-hongguo` 的 `publish.yml` 配置受信任发布者，并允许直接 `npm publish`。流程使用 GitHub 托管 runner、Node 24、npm 11 和仅发布 job 的 `id-token: write`，不保存长期 npm token。配置要求以 [npm 受信任发布者文档](https://docs.npmjs.com/trusted-publishers/) 为准；预演不验证 npm 账户端的发布授权。

`scripts/publish.mjs` 默认为预览；实际上传必须显式 `--publish`，且具备 CI OIDC、版本标签和三平台回执。本机 `npm run release:publish` 不再作为正式发布入口。`release/candidate.json` 绑定源码与产物，`release/qualifications/` 保存各平台安装回执，合并后的 `release/verification.json` 用于发布校验。公开用户安装和桌面实播仍需分别验收。

## Beta 发布

`npm run version:beta` 从 `0.0.34` 生成 `0.0.35-beta.1`，再次执行生成 `0.0.35-beta.2`。版本脚本同步 package、lock 和两个插件清单。已发布版本不可覆盖；不要移动已发布标签。

Beta 可以从功能分支发布。提交代码和版本后推送匹配标签（例如 `v0.0.35-beta.1`），沿用同一份产物的三平台回归和安装验收，再由原有 `publish.yml` 通过 OIDC 执行 `npm publish --tag beta`。发布脚本检查 beta 指向和包完整性，并确认 `latest` 未改变；不更新正式市场索引，也不向 main 提交 beta 发布记录。发布回执保存在 Actions 的 publication artifact。

Windows 用户始终使用 `npx.cmd "@kyun.si/codex-hongguo@beta" setup` / `update`，无需知道具体 beta 编号。安装器将自身 beta 版本写入独立版本目录的本机索引，并固定安装该版本。卸载识别 beta 索引，切换至 `@latest setup` 保留进度和设置。

准备转正式版时，`npm run version:patch` 将 `0.0.35-beta.N` 提升为 `0.0.35`，将正式源码合入 main 后再推送正式标签。正式发布仍要求 main 历史，并显式指定 `--tag latest`。发布渠道从版本推导，不能把 beta 版本标成 latest；已存在更新版本时拒绝回退渠道。
