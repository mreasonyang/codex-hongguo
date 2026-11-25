# npm 分发与发布

面向维护者。版本以源码根目录 `package.json` 为准；包名配置为 `@kyun.si/codex-hongguo`。默认市场由安装器在本机生成，仓库市场 `mreasonyang/codex-hongguo` 仅用于显式指定的 Git 来源。实际发布状态见 README 的发布提示，并以 npm registry 回读为准。

## 安装、更新与卸载

首发完成后的用户入口：

```sh
npx "@kyun.si/codex-hongguo@latest" setup
npx "@kyun.si/codex-hongguo@latest" update
npx "@kyun.si/codex-hongguo@latest" uninstall
```

`setup` 未指定应用时，在交互终端展示 Codex / Antigravity 的 checkbox 列表：↑/↓ 移动，空格勾选或取消勾选，回车确认，可同时勾选两端。引导显示已安装、未安装或暂无法确认的状态，再次执行可以补装另一端或重新安装已安装端；不选择某端不会卸载它。初始不勾选任何端，空选时回车会显示提示；Esc、Ctrl-C 或输入结束会取消安装。后台脚本须显式使用 `--codex`、`--agy` / `--antigravity`，或 `setup --codex --agy`，不再默认为脚本选择 Codex。旧的 `--host codex|antigravity` 参数保留。除 setup 外的命令只接受单端目标，未指定时保留入口默认值（npm 为 Codex，Antigravity 安装副本为 Antigravity）。

npx 获取包含完整程序的发行包。安装将程序安装到当前系统用户的共享目录；选择 Codex 时，在 `managed-marketplace/<安装器版本>/` 下生成本机市场和入口，并注册 `hongguo-local`。Antigravity 安装自己的清单、技能和 Node 入口，不要求 Codex CLI。两端启动时从同一份程序加载播放器、MCP 服务、SDK 和 WASM。更新会在切换入口前准备新构建，安装第二端时可复用已有构建。显式选择不支持共享安装协议的旧市场版本时，Codex 继续使用所选版本的原生布局。

安装和更新均支持 `--dry-run`；Codex 还支持 `--marketplace owner/repo|本地目录`。预览仍会检查依赖，但不修改注册。来源参数只接受仓库 slug 或现有本地目录；显式 Git 来源需要 Git。自定义或离线来源使用 `setup --codex --marketplace ...`，后续操作省略来源参数时会选择默认本机 npm 索引，因此每次都应显式提供。多端安装分别完成各端操作；一端失败仍会尝试另一端，成功的安装保留，并返回失败状态供重试。

`uninstall` 自动查找 Codex CLI 并移除插件；本机自管市场同时移除注册，随后清理该宿主的观看进度、设置、视频缓存、设备档案和 `managed-marketplace/` 索引。最后一个宿主卸载时会清理共享程序和播放组件。不下载或运行播放组件，也不检查 npm。支持 `--dry-run` 预览，不接受 `--marketplace`。卸载前关闭播放器面板，完成后打开新聊天。

Codex 和 Antigravity 在共享缓存的 `runtime/ffmpeg/` 下按构建和系统架构保存组件。自定义缓存路径为 `<HONGGUO_RUNTIME_DIR>/hongguo-shared/runtime/ffmpeg/`。安装时会从任一宿主的旧缓存校验并复用相同构建。旧版客户端仍可使用原路径，直到该宿主升级或卸载。

每次卸载清理当前宿主的默认用户数据。最后一个宿主卸载时，还会清空共享组件目录，包括历史版本、损坏程序和下载残片。组件目录之外保留一个小型 SQLite 文件，用于协调后续安装和卸载。清理时仅删除组件目录内及目录本身的符号链接，保留其目标和外部配置的 FFmpeg。自定义 `HONGGUO_DATA_DIR` 时仅清理插件的数据文件和子目录。清理失败时可重新运行卸载命令。

Antigravity 安装器退出时，系统会释放安装锁。如果升级前留下了旧版的空锁目录，确认旧安装命令均已退出后，删除报错中列出的空目录即可重试。

如果旧安装来自 ZIP，向导只替换同名市场并重新安装；失败会尝试恢复旧来源和插件注册。默认流程从旧 Git 来源迁移时，失败后提示重试本机安装，不重新拉取旧 Git 来源。观看数据不移动、不清理。迁移前关闭播放器，完成后打开新对话并审查 Hooks。安装器不收集或输出账号凭据，认证由现有 Codex/npm 客户端处理；它不写入 Hook 信任，也不转发宿主原始诊断输出。

`doctor` 输出播放环境元数据和固定的 Hooks 人工核对提示，不读取或判断授权状态。授权由用户直接在 Codex「设置 → Hooks」核对。

## 运行环境与包内容

npm 包的 `os` 为 darwin/linux/win32，Windows 需要 x64 或 ARM64 Node；ARM64 系统需要 Windows 11 和插件 >=0.0.30。Windows PowerShell 使用 `npx.cmd "@kyun.si/codex-hongguo@latest" setup`，详见 [Windows 支持](windows-support.md)。三平台的自动化安装验证与桌面播放观察分别记录。需要外部 Node.js >=22.16（含 npm）；仅 Codex 适配需要 Codex CLI。播放组件由安装器自动下载到用户缓存，校验固定的归档和可执行文件 SHA-256 后使用；不需要全局安装 FFmpeg。macOS 使用本项目从固定官方源码构建的组件，Windows/Linux 使用本项目独立发布的 BtbN 精简组件。包内提供 JavaScript 依赖、播放器、SDK/WASM、播放组件清单和许可说明。

MCP 使用同名的 `bin/run-node` / Windows `bin/run-node.exe` 入口，Hooks 按平台调用同一启动器。两者都检查 Node 版本及 `node:sqlite`；POSIX 保留 PATH、Homebrew、Volta、nvm、mise、fnm 查找，Windows 支持 PATH、常见 Node、Volta、nvm-windows 和 Scoop 位置。源码构建需 Go >=1.25，发行包使用者无需安装 Go。FFmpeg/Codex 通过 `src/runtime/executables.mjs` 查找，显式覆盖项见 [CONTRIBUTING](../CONTRIBUTING.md#运行环境与诊断)。覆盖值必须在实际宿主子进程的环境中可见。

源码根目录 `package.json` 的 `private: true` 用于阻止误发开发目录，公开包在 `release/npm/codex-hongguo/` 单独生成，包含：

- `.codex-plugin/plugin.json`、`.mcp.json`、`hooks/` 和 `skills/`。
- `assets/` 中的原创插件图标，兼容清单通过 `composerIcon` 和 `logo` 引用；便携源码清单使用相同资源。
- `bin/`、预构建的 `dist/cli/`、`dist/server/`、`dist/hooks/`、`dist/setup/` 和 `dist/ui/`。
- `dist/vendor/openhongguo/`，包括 WASM。
- 截取后的中英文 README、项目 AGPLv3 许可证 `LICENSE`、项目声明 `NOTICE`、amagi 的 GPLv3 许可证 `COPYING` 和 `licenses/` 第三方许可声明。
- `licenses/codex-hongguo-source.zip` 对应项目源码、构建脚本及 Windows 启动器源码，以及 `dist/licenses/amagi-6.6.0-source.tar.gz` 固定修订的 amagi 原始源码。

包不声明安装依赖或生命周期脚本，也不包含本机绝对路径、观看媒体、设备档案和凭据；对应源码 ZIP 包含仓库测试与固定媒体夹具。便携清单保留在源码，安装包采用已验证的兼容清单。项目采用 [AGPLv3 许可证](../LICENSE)，npm 元数据使用 `AGPL-3.0-only`；第三方依赖仍按各自许可分发，amagi 保留 GPL-3.0-only。历史 MIT 授权说明见 [NOTICE](../NOTICE)。
README 的界面截图以无损 WebP 留在源码仓库中，npm 包和离线 ZIP 均不携带截图。
打包后的中英文 README 使用与发行版本标签绑定的 GitHub 图片地址，保留截图展示。
安装验收检查安装目录中没有截图，且两份 README 的图片链接均指向该版本。

播放组件下载的总时限为 30 分钟，最多三次尝试共用该时限；等待另一安装完成的时限为 32 分钟。
安装过程每 30 秒更新锁的时间，避免旧版本将慢速下载误判为废弃安装。
环境检查的外层时限覆盖等待、下载与解压校验，不会在原先的 15 秒处提前结束。

Windows/Linux 精简组件由 `.github/workflows/ffmpeg-components.yml` 单独发布。
流程先核对固定上游归档的完整 SHA-256，提取唯一的普通可执行文件，再保留其原始字节重打包。
组件带 GPLv3、上游许可和来源说明；独立发行提供 FFmpeg 源码快照、固定构建脚本与依赖来源索引。
Windows/Linux x64 通过实际 H.264/AAC、HEVC 转 H.264、JPEG 封面和 framehash 检查后才发布。
ARM64 校验源归档、架构和可执行文件字节一致性；这些回执不代表 ARM64 实机播放验收。
组件使用独立的 `ffmpeg-*` 预发布标签，不推进 npm 正式通道或正式市场索引。

macOS 组件由 `.github/workflows/ffmpeg-macos.yml` 在 Apple Silicon 和 Intel runner 分别从源码构建。
`third_party/ffmpeg/macos-build.json` 固定 FFmpeg 官方发布归档及 VideoLAN x264 的完整修订、大小和 SHA-256。
编译关闭可选库自动探测和网络协议，静态链接 x264；成品只允许依赖 macOS 系统库，无需用户安装 Homebrew。
两个架构均通过 H.264/AAC、HEVC 解码和转 H.264、JPEG、framehash、HLS/fMP4、CENC、链接库与签名完整性检查后才发布。
独立的 `ffmpeg-macos-*` 预发布同时提供完整源码归档、构建脚本、参数、工具链和验收回执；发布后不覆盖原有组件。
组件更新需显式检查上游安全修复、更新源码固定值、运行构建并发布新标签，再将发布回读的固定值写入运行时清单。
`libx265` 编码不属于插件播放路径，macOS 构建不包含它；原生 HEVC 解码和转码为 H.264 保留。

精简组件的 `cacheKey` 保持原缓存目录。升级复用旧回执时，必须匹配本插件所有者、回执版本和固定的可执行文件哈希，
并重新校验实际文件；内存中的校验缓存也绑定该可执行文件身份。
因此仅改变压缩归档不会触发同一程序的重复下载，损坏、身份不符或被替换的程序仍需重新安装。


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

macOS 发布验收固定使用 `macos-26-intel`（x64）。`macos-latest` 当前使用 ARM64；其托管池容量不足时，任务可能在执行任何步骤前因无法取得 runner 而取消。任务的 `timeout-minutes` 控制执行时限，调大它不能修复 runner 分配失败。此类失败可先重跑失败任务；持续失败时，可从包含 runner 配置修复的分支手动运行 Publish，选择原有版本标签。发布源码仍由该标签固定，重新生成的候选包仍需通过三平台验收。Intel 回执不代表 Apple Silicon 的 CI 验收，后者需单独记录。参见 [GitHub runner 规格](https://docs.github.com/en/actions/reference/runners/github-hosted-runners)和[任务超时配置](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idtimeout-minutes)。

失败后优先在同一工作流中仅重跑失败的 job，复用原有验收包；也可以手动选择既有标签并明确勾选 `publish=true`。若 npm 已存在该版本，只有完整性完全一致才可继续收尾；若重新构建的内容不同，流程失败，不覆盖、不推进索引。不得移动已经发布的标签来替换内容。

npm 上传成功与公开元数据可见可能相隔数分钟。发布脚本最多等待十分钟回读版本、完整性和渠道指向；若仍超时，先检查 registry，再重跑原工作流的失败 job。仅因回读延迟不需要递增版本或再次上传。

### 跟随 openhongguo 正式版

修改工作流或版本检测脚本并推送到开发分支时，GitHub 会先运行只读预演。修改上游跟随流程或 SDK 固定版本的 PR 也会运行预演。在 `Follow openhongguo releases` 的 `preview` 摘要中可以看到当前版本、上游版本，以及是否需要人工审阅。

默认分支上的 `Follow openhongguo releases` 每六小时检查一次上游 GitHub Release。手动运行时默认只读预览，勾选 `publish` 可提前执行一次完整检查。跟踪范围是红果 SDK。上游进入新主版本、0.x 跨次版本、发布说明或提交声明破坏性变更时，Actions 摘要会列出人工审阅原因。请求签名、设备校验、所附许可有变化，或 GitHub 无法提供完整差异时，同样转人工审阅。

兼容候选固定到上游标签对应的提交、源码树和归档 SHA-256，并在独立分支递增插件补丁版本。三平台验收覆盖 SDK 类型、实际适配调用、回归和安装。通过后，机器人才把已测试的提交快进到 `main` 并创建插件标签。验收期间主线有新提交时，下次检查会在新基线上重新生成候选。失败的候选分支可供排查。

随后由机器人显式调度现有 `Publish`，针对该标签重新构建并执行完整的三平台发布验收，通过后经 npm OIDC 上传。两个流程使用仓库内置的 `GITHUB_TOKEN`。仓库规则需允许工作流写候选分支、快进主线、创建标签和调度 Actions。若标签已创建而调度中断，下一次检查会补调度；已启动的 Publish 有运行链接，遇到失败从该运行重试即可复用原有产物。

## npm 受信任发布者

在 npm 包设置中为 `mreasonyang/codex-hongguo` 的 `publish.yml` 配置受信任发布者，并允许直接 `npm publish`。流程使用 GitHub 托管 runner、Node 24、npm 11 和仅发布 job 的 `id-token: write`，不保存长期 npm token。配置要求以 [npm 受信任发布者文档](https://docs.npmjs.com/trusted-publishers/) 为准；预演不验证 npm 账户端的发布授权。

`scripts/publish.mjs` 默认为预览；实际上传必须显式 `--publish`，且具备 CI OIDC、版本标签和三平台回执。本机 `npm run release:publish` 不再作为正式发布入口。`release/candidate.json` 绑定源码与产物，`release/qualifications/` 保存各平台安装回执，合并后的 `release/verification.json` 用于发布校验。公开用户安装和桌面实播仍需分别验收。

## Beta 发布

`npm run version:beta` 从 `0.0.34` 生成 `0.0.35-beta.1`，再次执行生成 `0.0.35-beta.2`。版本脚本同步 package、lock 和两个插件清单。已发布版本不可覆盖；不要移动已发布标签。

Beta 可以从功能分支发布。提交代码和版本后推送匹配标签（例如 `v0.0.35-beta.1`），沿用同一份产物的三平台回归和安装验收，再由原有 `publish.yml` 通过 OIDC 执行 `npm publish --tag beta`。发布脚本检查 beta 指向和包完整性，并确认 `latest` 未改变；不更新正式市场索引，也不向 main 提交 beta 发布记录。发布回执保存在 Actions 的 publication artifact。

Windows 用户始终使用 `npx.cmd "@kyun.si/codex-hongguo@beta" setup` / `update`，无需知道具体 beta 编号。安装器将自身 beta 版本写入独立版本目录的本机索引，并固定安装该版本。卸载识别 beta 索引，切换至 `@latest setup` 保留进度和设置。

准备转正式版时，`npm run version:patch` 将 `0.0.35-beta.N` 提升为 `0.0.35`，将正式源码合入 main 后再推送正式标签。正式发布仍要求 main 历史，并显式指定 `--tag latest`。发布渠道从版本推导，不能把 beta 版本标成 latest；已存在更新版本时拒绝回退渠道。
