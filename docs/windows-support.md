# Windows 安装与验证

0.0.29 支持 Windows x64；0.0.30 增加 Windows 11 ARM64 和 ARM64 Node 支持。使用对应架构的 Node.js >=22.16（含 npm 和 `node:sqlite`）以及支持 npm 插件源的 Codex CLI；无需 WSL、Git Bash、`sh` 或自行安装 FFmpeg。ARM 机器可继续使用原生 ARM64 Node，无需改装 x64 Node。

## PowerShell 安装

从 0.0.31 起，默认安装和更新使用本机生成的 npm 市场索引，不再调用 Git 拉取索引；仍需要可运行的 Codex CLI。

```powershell
npx.cmd "@kyun.si/codex-hongguo@latest" setup
```

包名引号必须保留。未引用的 `@kyun.si/...` 会被 PowerShell 当成展开表达式，报 `SplattingNotPermitted`，此时安装程序尚未运行。`npx.cmd` 直接调用 npm 的命令入口；无需修改 PowerShell 执行策略。解析规则见 [Microsoft 文档](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing)。

安装程序自动下载、校验并缓存 Windows 播放组件。安装完成后，在 Codex「设置 → Hooks → 红果短剧」人工审查、信任并启用 `UserPromptSubmit`、`Stop`、`Interrupt`，然后打开新的本地聊天。安装程序不读取或写入信任记录。

从 0.0.35-beta.7 起，播放组件下载的总时限由 5 分钟增加到 30 分钟，最多三次尝试共用这个时限。
网络中断后仍从头下载；超过总时限会明确提示「下载已超过30分钟」。
并行安装时最多等待已有安装 32 分钟，环境检查也允许完整的准备时间。
已校验的组件会复用缓存，普通更新不会重复下载同一组件。

从 0.0.35-beta.8 起，Windows x64/ARM64 首次安装只下载包含 `ffmpeg.exe`、许可与来源信息的精简组件。
它与此前使用的上游程序字节一致，不附带未使用的 ffprobe、ffplay。已安装的同一程序通过哈希校验后直接复用，
无需因为归档重新打包而重复下载。组件由独立的 FFmpeg 预发布提供，npm 安装命令保持不变。

更新前关闭播放器与分屏，然后运行：

```powershell
npx.cmd "@kyun.si/codex-hongguo@latest" update
```

更新保留进度和设置。卸载会删除本插件的播放组件、观看进度、设置、视频缓存和设备档案：

```powershell
npx.cmd "@kyun.si/codex-hongguo@latest" uninstall
```

0.0.33 已发布以下卸载修复，npm 0.0.32 不包含此修复：任何删除或注销操作之前，会根据本插件缓存目录中的可执行文件路径检查后台启动器。若仍在运行，立即提示用户先关闭红果及相关 Codex 会话，缓存、市场配置与观看数据均不修改；卸载器不结束进程。确认已退出后，先删除插件缓存、注销本插件管理的本地市场，再清理观看数据。市场列表同时兼容 `marketplaceSource.source` 和只有 `root` 的格式，并解析 Windows 路径别名。

若缓存文件仍被占用或权限不足，卸载会给出明确提示并保留观看数据；请关闭红果播放器及使用插件的 Codex 会话后重试。外部自定义市场的注册和源文件会保留。已经卸载的插件可以重复运行卸载命令。

若 npm 报 `EBADPLATFORM`，Windows x64 请使用 0.0.29 或更新版本，Windows ARM64 请使用 0.0.30 或更新版本。0.0.29 的安装器仍会拒绝 ARM64 Node；更新到新版即可，无需使用 `--force`。

### 插件已启用，但 Hooks 页面为空

插件启用状态和钩子发现结果是两项独立的状态。先保留当前安装，使用 Windows 专用脚本收集安装副本与运行时发现结果：

```powershell
Invoke-WebRequest "https://github.com/mreasonyang/codex-hongguo/releases/download/v0.0.31/windows-hooks-diagnostics.cjs" -OutFile "$env:TEMP\hongguo-windows-hooks.cjs"
node "$env:TEMP\hongguo-windows-hooks.cjs"
```

脚本列出插件版本、发行包中的钩子文件和 Windows 启动器是否存在，并通过 npm/PATH CLI 与可定位的桌面内置引擎分别查询钩子发现结果。它不执行钩子、不修改配置或信任记录，不输出命令参数、环境变量、原始日志或其他插件的配置。`desktopEngineFound: false` 表示没有定位到桌面内置引擎，不能把 CLI 的结果当成桌面版的结果。请将输出中的 JSON 提供给维护者；无需提交完整日志或认证配置。

## Beta 测试安装

```powershell
npx.cmd "@kyun.si/codex-hongguo@beta" setup
```

后续更新使用同一命令的 `update`。关闭旧播放器和 Codex 后执行，完成后重新打开；保留观看进度和设置。返回正式渠道使用 `npx.cmd "@kyun.si/codex-hongguo@latest" setup`。测试版与正式版共用插件 ID，切换会替换当前安装，不同时运行两份。

## 离线 ZIP 安装

也可以解压 `release/codex-hongguo-<版本>.zip` 到长期保留的目录，在解压根目录的 PowerShell 执行：

```powershell
node .\plugins\codex-hongguo\bin\codex-hongguo.mjs setup --marketplace .
```

ZIP 包含插件程序，首次准备播放组件仍需联网。更新时切换到新版解压目录，重复上面的命令。从实际安装副本检查环境：

```powershell
& "<实际插件根目录>\bin\run-node.exe" check
```

## 运行时与数据

- Windows 使用固定入口 `run-node.exe` 启动 MCP 和 Hooks；在 ARM64 系统上自动转交 `run-node-arm64.exe` 原生启动器。Windows 11 自带的 x64 兼容机制只用于这个入口，之后按 Node 架构运行原生 Node 与播放组件。启动器检查 Node 版本和 SQLite，并透传 stdin/stdout 与退出码。宿主终止启动器时通过 Windows Job 回收 Node 及子进程。
- `HONGGUO_NODE` 可指定 x64 或 ARM64 `node.exe` 的绝对路径；设置后不会静默回退。未设置时检查绝对 PATH 项、常见 Node、Volta、nvm-windows 和 Scoop 安装位置。
- `HONGGUO_FFMPEG` 与 `HONGGUO_CODEX` 可覆盖程序路径，后者允许 `.exe`、`.cmd`。变量必须能被 Codex 子进程读取；仅在安装终端中设置不能保证桌面继承。
- 进度与缓存位于 `%LOCALAPPDATA%\CodexHongguo\`，缺省为 `%USERPROFILE%\AppData\Local\CodexHongguo\`。卸载删除这些数据；只想暂时停用时在 Codex 中禁用插件。
- 源码构建需要 Go >=1.25 交叉编译 Windows x64 和 ARM64 启动器；使用发行包不需要 Go。

## 自动化与桌面观察

0.0.30 的 ARM64 运行路径按用户要求仅构建打包，本次未执行运行验证，实机验收由用户完成。

0.0.32 修复 Windows 回合钩子的 Shell 命令：旧版使用 `"%PLUGIN_ROOT%\bin\run-node.exe" hook`，在 PowerShell 下会报 `Unexpected token 'hook'`。新版由宿主 PowerShell 直接使用调用运算符 `&` 执行原生启动器，插件路径在执行时从 `$env:PLUGIN_ROOT` 读取，兼容空格、中文及特殊字符；同时显式读取 UTF-8 stdin 并透传事件 JSON，避免原生进程等待输入结束。命令适用于 Windows PowerShell 5.1 和 PowerShell 7。修改钩子命令后，需要在桌面版重新审查并信任更新后的三个 Hooks。

同版将 `UserPromptSubmit` 的超时从 2 秒改为 10 秒；`Stop` 和 `Interrupt` 为 3 秒，后者符合宿主的超时上限。旧版 2 秒的整体预算小于启动器 3 秒的单次 Node 探测预算，在冷启动和 ARM64 转交时可能来不及输出推荐卡片指令。

`windows-hooks.yml` 针对 Windows x64 与 Windows 11 ARM64，通过真实 Windows PowerShell 5.1 和 PowerShell 7 执行发行包中的三个钩子命令，并验证 stdin、推荐指令输出和停止状态写入。测试也在 PowerShell 中重现旧命令的解析错误，不再只直接启动 EXE。执行结果以对应 Actions 记录为准；桌面自然回合与实际卡片显示仍由用户验收。

`ci.yml` 在 macOS、Linux、Windows x64 执行构建、回归、打包和隔离 npm 安装。Windows 安装验证不设置 `npm_config_force`，并分别在 Windows PowerShell 5.1 和 PowerShell 7 中执行带引号的 `npx.cmd` 命令；同时覆盖中文及空格路径、原生启动器、MCP 资源、Hooks 状态写入、更新保留进度与完整卸载。发布 workflow 依赖三平台验证通过。

自动化不能代替桌面画面、声音和自然回合事件观察。在 Windows Codex 桌面仍需独立记录以下结果：

1. 选剧、静音/出声、跳转、换集、HEVC/非 AAC 转换，以及无硬件编码器时的软件回退。
2. 退出 Codex 后重新打开，确认剧集、播放位置和设置恢复。
3. 人工信任三个 Hooks 后，在真实任务自然完成和手动中断时观察前台及后台播放器暂停，并检查手动续播。

当前修改的三平台 CI 结果与发行状态以对应提交的 Actions 和 npm registry 为准；桌面观察尚未作为自动化结果宣称通过。
