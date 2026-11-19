---
name: hongguo-setup
description: 配置红果短剧插件，检查本机播放环境和回合自动暂停，带用户完成安装后的首次使用。适用于红果设置、安装后不会用或自动暂停不生效。
---

帮助用户在当前安装环境完成红果短剧配置。该插件用于本机执行的 Codex 或 Antigravity App 对话，不需要红果账号、API Key 或浏览器自动化权限。

## Antigravity App

当前宿主为 Antigravity 时，使用本节。根据此文件向上两级定位插件根目录，运行 `node "<插件根目录>/bin/codex-hongguo.mjs" doctor --agy`；安装器固定了本机 Node 路径，可从本插件 `mcp_config.json` 的 command 获取。Node 需要 >=22.16。

Codex 和 Antigravity 共用同一套程序，观看进度和片源各自保存。Antigravity 使用 npm `beta` 渠道，按平台和操作选择命令。

| 平台 | 首次安装 | 更新 |
| --- | --- | --- |
| macOS / Linux | `npx "@kyun.si/codex-hongguo@beta" setup --agy` | `npx "@kyun.si/codex-hongguo@beta" update --agy` |
| Windows PowerShell | `npx.cmd "@kyun.si/codex-hongguo@beta" setup --agy` | `npx.cmd "@kyun.si/codex-hongguo@beta" update --agy` |

`--antigravity` 与 `--agy` 等价，旧的 `--host antigravity` 仍支持。用户自己在终端运行不带目标的 `setup` 时，会出现可多选的安装引导；再次运行可补装另一端。代理或脚本执行时显式指定当前宿主，避免等待交互输入；不要擅自安装用户未选择的另一个宿主。

安装或更新后重新打开 Antigravity 桌面 App，新建本地会话。点击会话右上角的菜单，选择 Extensions → 红果短剧，在会话侧栏打开播放器。更新后可在左侧 Customizations → Installed → 红果短剧 → MCP 重启 `hongguo`。

自动推荐和播放联动需要用户在左侧 Customizations → Installed 确认“红果短剧”插件已启用。PreInvocation、Stop 随插件加载，无需分别开启。推荐还需要播放器设置中的「当前回合进行时显示推荐」。发送普通消息后，Hook 会请模型在聊天里显示剧目和播放器入口，点击「红果短剧」打开同一个侧栏面板。侧栏自动关联打开它的对话，并按播放器设置在回合结束时暂停。

用 `doctor --agy` 的 `hookActivity` 判断是否记录过开始和结束事件。插件启用和授权由用户在宿主中确认。实际视频和回合联动未经观察时必须标记待验证。完成后停止，不执行下面的 Codex 指令。

## Codex App

安装或修复时沿用当前插件的 npm 渠道：根据插件 `package.json` 中的版本，含 `-beta.` 时使用 `@beta`，其余使用 `@latest`。下方命令以正式渠道为例；当前安装为 beta 时将 `@latest` 换成 `@beta`。代理执行时显式使用 `--codex`，用户在终端自行运行不带目标的 `setup` 时可多选应用。

默认安装和更新使用持久的本机 npm 市场索引，不要求 Git；仍需要可运行的 Codex CLI。只有显式指定 Git 市场来源时才需要 Git。

从此 SKILL.md 的实际位置向上两级确定插件根目录。在 macOS/Linux 用 `sh "<插件根目录>/bin/run-node" check` 检查；Windows x64 / Windows 11 ARM64 在 PowerShell 用 `& "<插件根目录>\bin\run-node.exe" check`。启动器自动寻找 Node，并检查版本及 SQLite。正确引用包含空格的路径。脚本只输出 Node、进度库、FFmpeg 的环境元数据，以及固定的 Hooks 人工授权核对提示，不检测授权状态，不发送模型请求。npm 包支持 macOS/Linux、Windows x64 和 Windows 11 ARM64，Windows x64/ARM64 启动器随 npm 包和离线包提供。

- 需要 Node.js >=22.16。播放组件由插件自动下载、校验并缓存，无需用户自行安装 FFmpeg。首次需要联网；准备失败时检查网络，macOS/Linux 重新运行 `npx "@kyun.si/codex-hongguo@latest" setup --codex`，Windows 重新运行 `npx.cmd "@kyun.si/codex-hongguo@latest" setup --codex`。PowerShell 中以 `@` 开头的 npm 包名必须加引号，以免出现 `SplattingNotPermitted`；调用 npm 工具时使用 `npx.cmd`、`npm.cmd`。Windows 接受 x64 或 ARM64 Node；ARM64 机器使用 Windows 11 和插件 >=0.0.30，可保留原生 ARM64 Node。特殊安装可使用 HONGGUO_NODE、HONGGUO_FFMPEG、HONGGUO_CODEX 指定程序；不要修改用户其他插件、认证或网络配置。
- Hooks 授权不执行检测。固定提示用户打开 Codex「设置 → Hooks → 红果短剧」，人工检查、信任并启用 UserPromptSubmit、Stop、Interrupt。不得自动宣称已授权或无需重复授权，不读取或写入信任记录，不把历史回合事件当成授权证明。

告诉用户从新本地对话的右侧 ＋ 搜索“红果”，或在“更多工具”的“插件和 MCP”分组打开红果短剧。点击推荐或搜索结果即可开播，默认静音；打开扬声器出声。未完成 Hooks 配置时仍可手动观看。

当用户选择验证回合联动时，在真实本地对话进行中打开面板并点播，观察回合结束或中断后是否暂停，再点普通播放键检查能否从原处继续。没有实际观察到视频暂停，就将这一项保留为待验证。结束时简短说明播放环境与仍需用户人工核对的 Hooks 授权事项，避免把检查通过当成完整桌面 E2E。
