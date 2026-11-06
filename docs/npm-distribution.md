# npm 分发与发布

面向维护者。版本以源码根目录 `package.json` 为准；包名配置为 `@kyun.si/codex-hongguo`，默认 GitHub 市场为 `mreasonyang/codex-hongguo`。实际发布状态见 README 的发布提示，并以 npm registry 回读为准。

## 安装、更新与卸载

首发完成后的用户入口：

```sh
npx @kyun.si/codex-hongguo@latest setup
npx @kyun.si/codex-hongguo@latest update
npx @kyun.si/codex-hongguo@latest uninstall
```

命令检查 Node、npm 和 Codex CLI，自动准备播放组件，再通过 Codex 原生市场安装插件。Git 仓库的 `.agents/plugins/marketplace.json` 指向 npm 的确定版本；CLI 沿用 `codex-hongguo@hongguo-local` 标识。`setup` 和 `update` 均会注册来源，对已经登记的同一 Git 来源先刷新市场，再安装，避免重装时沿用旧索引。

两个命令均支持 `--dry-run` 和 `--marketplace owner/repo|本地目录`。预览仍会检查依赖，但不调用 Codex 修改注册。来源参数只接受仓库 slug 或现有本地目录。后续操作省略该参数时会选择默认 GitHub 来源，因此自定义和离线来源每次都应显式提供。

`uninstall` 自动查找 Codex CLI 并移除插件，删除播放组件、观看进度、设置、全部视频缓存和设备档案；不下载或运行播放组件，也不检查 npm。支持 `--dry-run` 预览，不接受 `--marketplace`。卸载前关闭播放器面板，完成后打开新聊天。

组件目录归属通过固定命名空间确定。默认使用插件专用缓存下的 `runtime/ffmpeg/`；自定义缓存时使用 `<HONGGUO_RUNTIME_DIR>/codex-hongguo/runtime/ffmpeg/`。卸载清空这个专属目录，包括损坏程序、缺失或损坏的回执、未知旧版本、安装锁和下载残片；同时删除默认用户数据目录。目录内及目录本身的符号链接只删除链接，不跟随目标；目录外的系统或自配 FFmpeg、自定义目录的无关内容不删除。自定义 `HONGGUO_DATA_DIR` 时删除插件的 SQLite 及附属文件、`media/`、`panel-media/`、`device/`。完整性校验用于安装和运行，不作为留下组件文件的理由。无法清理时返回失败并提示重试，重复卸载可以继续清理。

如果旧安装来自 ZIP，向导只替换同名市场并重新安装；失败会尝试恢复旧来源和插件注册。观看数据不移动、不清理。迁移前关闭播放器，完成后打开新对话并审查 Hooks。安装器不收集或输出账号凭据，认证由现有 Codex/npm 客户端处理；它不写入 Hook 信任，也不转发宿主原始诊断输出。

`doctor` 输出播放环境元数据和固定的 Hooks 人工核对提示，不读取或判断授权状态。授权由用户直接在 Codex「设置 → Hooks」核对。

## 运行环境与包内容

当前 npm 包的 `os` 仍为 darwin/linux。Windows x64 原生启动器已随包构建，可通过离线 ZIP 试用；完整桌面验收通过前不开放 Windows npm 安装，见 [Windows 支持](windows-support.md)。本机验收平台为 macOS；Linux 实机仍待验证。需要外部 Node.js >=22.16（含 npm）和 Codex CLI。播放组件由安装器自动从原始发行者下载到用户缓存，校验固定的 SHA-256 后使用；不需要全局安装 FFmpeg。包内提供 JavaScript 依赖、播放器、SDK/WASM、播放组件清单和许可说明。

MCP 使用同名的 `bin/run-node` / Windows `bin/run-node.exe` 入口，Hooks 按平台调用同一启动器。两者都检查 Node 版本及 `node:sqlite`；POSIX 保留 PATH、Homebrew、Volta、nvm、mise、fnm 查找，Windows 支持 PATH、常见 Node、Volta、nvm-windows 和 Scoop 位置。源码构建需 Go >=1.25，发行包使用者无需安装 Go。FFmpeg/Codex 通过 `src/runtime/executables.mjs` 查找，显式覆盖项见 [CONTRIBUTING](../CONTRIBUTING.md#运行环境与诊断)。覆盖值必须在实际宿主子进程的环境中可见。

源码根目录 `package.json` 的 `private: true` 用于阻止误发开发目录，公开包在 `release/npm/codex-hongguo/` 单独生成，包含：

- `.codex-plugin/plugin.json`、`.mcp.json`、`hooks/` 和 `skills/`。
- `bin/`、预构建的 `dist/cli/`、`dist/server/`、`dist/hooks/`、`dist/setup/` 和 `dist/ui/`。
- `dist/vendor/openhongguo/`，包括 WASM。
- 截取后的中英文 README、项目 MIT 许可证 `LICENSE` 和 `licenses/` 第三方许可声明。

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
| `release/verification.json` | 成功的安装回执，包含版本、全新安装检查项和 tgz 的 SHA-256。 |

隔离验证创建本地 HTTPS npm 测试仓库及临时 CA，在临时 HOME/Codex 配置下执行真实 npm exec/npx 和 Codex 原生 npm 下载；生产 TLS 策略不变。从空白 HOME/Codex 配置全新安装，检查进度、设置、宿主工具、两个 UI 资源、真实片库/分集、三个待信任 Hooks，以及卸载删除全部本地数据。

额外验证真实分集解码时运行：

```sh
node scripts/verify-install.mjs --playback
```

`--playback` 取回安装副本提供的初始化段与媒体段，用 FFmpeg 解码。它不等同于桌面视频控件实播；回执的 `desktopPlaybackObserved` 固定为 false。公开 npm/GitHub 的真实安装链路、桌面画面与自然回合自动暂停、Linux 实机需分别验收，不能从本地测试仓库的成功推导为已上线。

重新打包会使旧回执失效，需要重新安装验证。已发布的 npm 名称/版本不能覆盖，修改已发布内容应递增版本；见 [npm publish 文档](https://docs.npmjs.com/cli/v11/commands/npm-publish/)。

## 首次上线

1. 确认默认 GitHub 仓库与 `src/cli/main.mjs`、打包元数据一致，将 `main` 推送到用户可访问的仓库，确认其中的市场清单可读取。
2. 在自己的终端完成 `npm login --registry=https://registry.npmjs.org`，确认有目标包发布权限。账户认证在本机或 npm 网页完成，不把令牌和验证码写进聊天、证据文件或仓库。
3. 完成上面的测试、打包和安装验证。发布对象是回执绑定的 tgz。
4. 非交互环境可运行 `npm run release:publish`。脚本隐藏 npm 原始输出，不能代为完成交互式登录或双重认证。需要交互认证时，在自己的终端运行下方命令，将版本占位替换为实际版本：

   ```sh
   npm publish "./release/kyun.si-codex-hongguo-<版本>.tgz" --access public --registry=https://registry.npmjs.org
   npm run release:publish -- --index-only
   ```

5. 脚本回读 registry 中该版本的 SHA-512 完整性，与同一 tgz 比对后才更新仓库索引及中英文 README 的发布提示。发布和 `--index-only` 之间保留原 tgz，不重新打包。
6. 将更新后的索引和 README 提交并推送到 `main`，再在干净环境实际执行公开 `npx ... setup`。公开入口验证完成后再调整 README 中对应的验收状态。

发布中断后，若 npm 已有同版本，用原 tgz 与回执执行 `--index-only` 核验并更新索引。若完整性不同，保留现场核对版本与产物；此时脚本不会推进市场索引。

## 后续 CI 发布

发布 workflow 为 `.github/workflows/publish.yml`，由维护者手动触发并检出 `main`。先按项目版本规则运行 `npm run version:patch` 并提交源码变更；版本递增不会提前更新发布索引。

在 npm 包设置中为 `mreasonyang/codex-hongguo` 的 `publish.yml` 配置受信任发布者，并明确允许直接 `npm publish`，与现有 workflow 的命令一致。npm 要求 CLI >=11.5.1 和 Node >=22.14；当前 workflow 使用 Node 24、npm 11、GitHub 托管 runner 以及 `id-token: write`，通过 OIDC 发布而不保存 npm 长期令牌。配置字段与权限以 [npm 受信任发布者文档](https://docs.npmjs.com/trusted-publishers/) 为准。

发布前先通过 `ci.yml` 的 macOS/Linux/Windows 三平台构建、回归、打包和隔离安装。Windows 自动化在临时环境中允许安装试用产物，不改变公开 npm 平台限制。发布 job 再测试、打包、隔离安装并上传验收产物，然后发布带 provenance 的 tgz；registry 完整性回读通过后提交并推送索引和 README。workflow 文件已提供，实际 Actions 执行及 npm 受信任发布者配置仍需上线时验证。
