# 开发与维护指南

用户安装和观看说明见 [README.md](README.md)（[English](README.en.md)）；npm 包结构、首次上线和 CI 发布见 [npm 分发说明](docs/npm-distribution.md)。版本以 `package.json` 为准。

## 开发环境

- Node.js >=22.16，包含 `node:sqlite`，并有 npm 可执行程序。
- 播放组件由插件自动下载并校验，无需全局 FFmpeg。首次运行测试需要联网。
- Codex CLI：需要 `plugin` 和 `app-server` 子命令及 npm 插件源支持。本机隔离验收与发布 workflow 使用 0.157.1；这不是对所有其他版本的兼容性保证。
- Go >=1.25：构建时交叉编译 Windows x64/ARM64 原生启动器，无 CGO；使用发行包不需要 Go。
- OpenSSL：隔离安装脚本用它生成本地 HTTPS 测试仓库的临时证书。

npm 包支持 macOS/Linux、Windows x64 和 Windows 11 ARM64。ARM64 0.0.30 此次按用户要求仅构建打包，运行验收由用户完成。CI 只构建和打包一次，三平台共用该产物进行回归与隔离 npm 安装；Windows 另覆盖 PowerShell 5.1/7 安装命令。桌面画面、声音和自然回合联动需独立观察，详见 [Windows 支持](docs/windows-support.md)。

## 构建与验证

从源码根目录运行：

```sh
npm ci
npm test
npm run package
npm run verify:install
```

| 命令 | 作用 |
| --- | --- |
| `npm run build` | 校验版本与前端类型，打包 MCP、Hooks、Setup、CLI，复制上游 SDK/WASM，并内联生成播放器 HTML。 |
| `npm test` | 先构建，再运行 `test/*.test.mjs`；覆盖回合状态、推荐轮换、安装迁移和恢复、持久化、解密、转码与媒体传输。测试数量以当次输出为准。 |
| `npm run package` | 生成完整 npm tgz、同产物离线 ZIP、待发布索引和包元数据。源码根目录的 package 保持 `private: true`，实际发布包单独生成。 |
| `npm run verify:install` | 从空白配置安装原生 npm 源，验证真实 npm exec/npx 安装和重复安装、宿主工具与 UI 资源、片库/分集、安装时进度保留、待信任 Hooks、npx 卸载及预览、损坏组件与残片清理、重复卸载、删除全部本地数据；成功后写入绑定 tgz 哈希的回执。需要联网。 |
| `npm run verify:antigravity` | 先运行 package；在临时配置中安装发行包，验证真实 stdio MCP、面板元数据、Hook 去重与取消、推荐会话绑定、样例媒体传输与 FFmpeg 解码、更新保留进度和卸载。不会修改个人 Antigravity 配置或发起模型请求。 |

安装验证从空白配置开始，不验证旧版兼容。额外验证真实分集解码时运行：

```sh
node scripts/verify-install.mjs --playback
```

`--playback` 额外经安装副本准备真实分集，通过 MCP 取回初始化段和媒体段，再用 FFmpeg 解码；默认验证不执行此项。隔离验证使用临时数据和配置，不信任个人 Hooks，不发起模型请求。

这仍不等同于桌面视频控件已实播或真实任务自然结束已触发暂停。当前回执的 `desktopPlaybackObserved` 固定为 `false`；桌面画面、听音、自然 Stop/Interrupt 和 Linux 实机需另行观察。回执只对应其绑定的 tgz，重新打包后需重新执行安装验证。

中英文 README 必须保留 `<!-- development -->` 分界，且其后内容非空；打包只收录分界前的消费者指南。Codex 安装使用 `.codex-plugin/plugin.json` 与 `.mcp.json`，源码中的便携清单不装入包内，以沿用已在 0.157.1 验证的 Hooks 发现方式。Antigravity 使用 `.antigravity-plugin/plugin.json`、`mcp_config.json` 与根级 `hooks.json`，安装器生成转发入口并固定本机 Node 路径。Windows Hooks 由 cmd 调用系统 PowerShell，从 MCP 清单读取 Node 的 Unicode 路径，并传递 UTF-8 事件。macOS 和 Linux 使用 POSIX shell。

两个 App 通过固定入口选择各自的数据目录。共享程序保存在 macOS 的 `~/Library/Application Support/HongguoShared/program/`、Windows 的 `%LOCALAPPDATA%\HongguoShared\program\` 或 Linux 的 `${XDG_DATA_HOME:-~/.local/share}/hongguo-shared/program/`。宿主入口在启动时读取同一个 `current.json`。每次更新都按完整文件内容识别构建，更新后重启正在使用的服务。Codex 保留 `server/index.mjs`、`hooks/write.mjs`、`setup/check.mjs`；Antigravity 分别使用对应目录的 `antigravity.mjs`。Store、Service、媒体准备、Setup 和 Provider 工作进程显式接收同一 App 配置，不读取或写入 `HONGGUO_HOST`。CLI 的 `--host` 仅指定本次命令的目标；Antigravity 安装副本的 CLI 固定默认目标，不靠环境变量或所有权标记推断。Codex 请求直接发送，四并发队列只用于 Antigravity。`test/host-isolation.test.mjs` 覆盖反向环境变量、双进程会话与进度隔离，以及单边清理；Antigravity 发行包验收同时验证 Provider 子进程，以及卸载一个宿主后另一个宿主仍可运行共享 FFmpeg。

Antigravity 的普通面板在宿主未传入会话元数据时保持未绑定，必须显式选择会话；推荐 Hook 使用随机回合能力值把卡片绑定到所属聊天，不让模型传入任意会话 ID。Hook 只记录会话 ID、开始步数和随机回合 ID，忽略中间模型调用及 `fullyIdle=false` 的普通 Stop；`USER_CANCELED` 记录中断。重放较早的开始事件不会复活旧回合。恢复、回退对话与其他 Stop Hook 强制继续等宿主行为仍需实机验收。

插件目录也会被 Antigravity CLI / IDE 发现。Hook 仅根据官方 `transcriptPath` 的 App 路径后缀识别来源，不打开或存储 transcript，其他来源保持静默。配置及事件格式参考 [构建插件](https://antigravity.google/docs/build-plugins) 和 [Hooks](https://antigravity.google/docs/hooks)。

Antigravity 2.32.1 本机随包指南及前端确认：宿主标识为 `Antigravity` / `web`，入口使用 `com.google.antigravity/ui` 的 `aux_pane` / `global`；只提供 inline 显示模式，最多 4 个并发应用调用，不发送 teardown。前端对请求排队并优先保存与状态读取；推荐卡本地展开到 760px，普通面板占满侧栏。协议测试不能替代解码后的画面、声音、账号能力开通和自然 PreInvocation/Stop 的桌面验证；`release/verification-antigravity.json` 明确保留这些未验收项。

## 代码目录

| 目录或文件 | 职责 |
| --- | --- |
| `src/hooks/write.mjs` | 读取回合事件，写入允许的状态字段；符合条件时提示模型调用一次可选推荐工具。 |
| `src/server/store.mjs` | SQLite 进度、回合、设置、推荐轮换和播放器可见性记录。 |
| `src/server/service.mjs` | 会话/回合绑定、面板能力、推荐领取、分集授权和应用工具调用。 |
| `src/server/index.mjs`、`antigravity.mjs`、`app.mjs` | 两个固定 App 入口调用共享服务，注册 MCP 工具及 `ui://hongguo/v41/player`、`ui://hongguo/v41/waiting` 两个 UI 资源，兼容旧 URI。 |
| `src/server/catalog.mjs` | 统一片库、推荐、搜索、分集、封面与缓存编排。 |
| `src/server/sources/`、`providers/` | 适配契约、限定 ID、红果驱动与内置/本地 Provider 注册、发现和生命周期；接口见 [Provider 插件](docs/providers.md)。 |
| `src/server/media.mjs`、`adaptive.mjs` | 整集获取、授权媒体解密/重封装、HLS/DASH 输入和主媒体缓存。 |
| `src/server/panel-media.mjs`、`mp4-duration.mjs` | 面板 H.264/AAC 准备、硬件转码及软件回退、渐进 fMP4 分片、完整时长及分块读取。 |
| `src/server/browser.mjs` | 一次性本机分屏配对、会话与媒体访问控制。 |
| `src/ui/` | 片库、播放器、推荐卡片、宿主交互和中英文界面。 |
| `src/cli/`、`src/runtime/`、`bin/` | npm 命令入口、原生市场安装/更新/卸载、运行时发现和 POSIX 启动器；`launcher/windows/` 为 Windows x64/ARM64 启动器源码。 |
| `scripts/` | 构建、打包、版本同步、隔离安装验证和发布。 |

`show_waiting_picks` 是模型可见的推荐入口，其余播放器操作由应用界面调用。推荐卡片和播放器共用 HTML，但使用不同资源与展示模式；更改卡片进入播放器的流程时，需要同时检查 `waiting.ts` 和 `player.ts`。

## 修改时需要保持的行为

- 播放器只跟随所属聊天。全局自动暂停与任务开始自动播放均默认开启；关闭自动暂停后可持续播放。自动播放只在观察到新的运行回合时启动已选剧集，首次打开、重复快照、状态失联、关闭面板和其他聊天的事件不能误触发；延迟准备完成前须重查回合及开关，手动暂停不能被当前回合的轮询撤销。升级时保留用户明确保存的关闭设置。
- 每回合最多创建一张推荐卡片。候选在该回合内固定，实际可见后才推进轮换；同一数据目录下跨对话共享轮换，已有观看记录的剧不作为新剧再次推荐。
- 切到下一集、恢复后期分页中的分集或重建播放器时，保持原始会话与点击意图，过期点击不能开播。
- 红果旧 ID、历史和媒体文件保持可读；每个面板独立选源，默认来源只影响后续打开。切源时丢弃旧请求结果、清除旧媒体授权并停止预取；固定回合候选保持来源。Provider 加载失败不得覆盖内置来源。
- 进度写入失败必须向用户说明；不能把内存降级存储说成已保存。安装、更新和来源变更保留观看数据；卸载删除进度、设置、缓存和设备档案。
- 主缓存 `media/` 的 40 集/1 GiB 策略不包含 `panel-media/` 临时分片。分片按活动状态与空闲时间独立回收，不能把主缓存上限描述成整个数据目录的大小上限。
- 不把媒体密钥、源媒体地址或面板能力值写入日志。媒体解密信息通过内存与 FFmpeg 标准输入传递，不放进进程参数。
- Hook 只保存 `session_id`、`turn_id`、`hook_event_name` 对应状态，不保存原始输入、提示词或回复。异常时返回 `{}`，不阻断宿主任务。
- Setup 只检查播放环境；Hooks 授权固定提示用户在 Codex 原生设置人工核对，不读取或判断授权状态，不自动写入信任记录。诊断只输出必要元数据，不转发完整环境、进程参数或宿主原始日志。

## 版本号

```sh
npm run version:patch
```

版本格式为三段 0–999 的整数。此命令只递增第三位，并同步 `package.json`、lockfile、`plugin.json` 和 `.codex-plugin/plugin.json`。第三位达到 999 后停止自动递增，调整前两位由维护者明确指定。手工修改后可用 `node scripts/version.mjs --sync` 同步清单。

构建、打包、测试和本地候选安装不会递增版本。一个未发布版本可以累计多次修复，只在准备下一次正式发布时递增一次；已发布的 npm 版本不能被覆盖。

普通提交只运行 CI。维护者确认后推送与版本一致的 `v<版本>` 标签，触发 CI 固定该提交、构建一次、三平台验收同一份包，再通过 npm OIDC 发布该 tgz。市场索引和发布记录只在 registry 完整性回读成功后更新。手动运行 Publish 且保持 `publish=false` 可预演完整流程；详见 [CI 发布说明](docs/npm-distribution.md#版本与-ci-发布)。

## 运行环境与诊断

| 环境变量 | 读取方与用途 |
| --- | --- |
| `HONGGUO_DATA_DIR` | Codex 的 SQLite、视频缓存、片源和设备数据目录。 |
| `HONGGUO_ANTIGRAVITY_DATA_DIR` | Antigravity 的独立数据目录。若曾在本分支早期版本为 Antigravity 单独设置过 `HONGGUO_DATA_DIR`，请把原路径改设到此变量。两个宿主的数据目录需互不包含。 |
| `HONGGUO_PROGRAM_DIR` | 两端共用的程序根目录，可指定绝对路径。 |
| `HONGGUO_NODE` | `bin/run-node` / `run-node.exe`：指定 Node >=22.16 的绝对路径（Windows 需 x64 或 ARM64）。它不改变 npx 自身使用的 Node。 |
| `HONGGUO_FFMPEG` | 高级覆盖项：指定 FFmpeg 可执行文件的绝对路径，省略时使用插件自动准备的组件。 |
| `HONGGUO_RUNTIME_DIR` | 指定播放组件缓存根目录。两个宿主共用其下的 `hongguo-shared/runtime/ffmpeg/`，按构建和系统架构区分。 |
| `HONGGUO_CODEX` | 安装、更新和卸载：指定 Codex CLI。 |
| `HONGGUO_PROFILE_PATH` | Catalog：指定匿名 SDK 设备档案位置。 |
| `HONGGUO_PROVIDERS_DIR` | 可选：显式指定本地 Provider 插件父目录，启动时发现；省略时仍会发现通过 provider install 安装的来源。 |

覆盖项必须在实际启动服务、Hook 或 Setup 的进程环境中可见。只在运行 npx 的终端里设置，不代表桌面宿主或其子进程继承了这些值；安装器不会把它们写进发布包。

构建后可运行 `node bin/codex-hongguo.mjs --help` 查看命令，`doctor` 输出播放环境元数据与固定的 Hooks 人工核对提示。检查与安装相关的 `--dry-run` 仍会检查 Node、npm 和 Codex，但不会下载播放组件。Hooks 授权不执行检测，由用户直接在 Codex「设置 → Hooks」核对。

`uninstall [--dry-run]` 只检查 Node 和 Codex，不依赖播放组件或 npm 可执行程序；移除插件后清理该宿主的默认用户数据，包括进度、设置、整集/面板视频缓存和设备档案。最后一个宿主卸载时清理共享组件目录，包括损坏文件、历史组件和下载残片。不跟随符号链接，不删除自定义目录内的无关文件。清理失败时返回失败，重复运行可重试清理。默认共享缓存位于 macOS 的 `~/Library/Caches/HongguoShared/`、Windows 的 `%LOCALAPPDATA%\HongguoShared\Cache\`、Linux 的 `${XDG_CACHE_HOME:-~/.cache}/hongguo-shared/`。自定义 `HONGGUO_DATA_DIR` 时只删除保留给插件的 `player.sqlite` 及 WAL/SHM/journal、`media/`、`panel-media/` 和 `device/`。

需要桌面调试项目时，先打包，再运行 `node scripts/prepare-inline-trial.mjs`，从 Codex 打开生成的 `release/桌面对话试用`。这个项目使用独立数据目录和项目 Hooks，并在该项目内禁用全局红果实例；首次仍需审查项目 Hooks。

## 参考

- [OpenAI 插件扩展](https://developers.openai.com/plugins/build/extensions)
- [插件打包与分发](https://developers.openai.com/plugins/build/plugins)
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [openhongguo](https://github.com/beilunyang/openhongguo)
- [dsh-hongguo](https://github.com/frostming/dsh-hongguo)
