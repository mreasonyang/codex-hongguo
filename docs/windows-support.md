# Windows x64 试用与验收

Windows 原生入口已实现，目标是使用 x64 Node 的 Windows 本地执行环境。无需 WSL、Git Bash 或 `sh`。依赖仍为 Node.js >=22.16（含 npm 和 `node:sqlite`）、支持插件市场的 Codex CLI、FFmpeg（建议 >=8）。Windows ARM64 原生运行时暂未覆盖。

当前 npm 包仍限制为 macOS/Linux。Windows 完整桌面验收尚未完成，先通过离线 ZIP 试用；不要为日常安装绕过 npm 的平台限制。

## 安装试用包

安装依赖并确认 `node --version`、`npm.cmd --version`、`codex.cmd --version`、`ffmpeg -version` 可运行，然后重启 Codex。解压 `release/codex-hongguo-<版本>.zip` 到长期保留的目录，在解压根目录的 PowerShell 执行：

```powershell
node .\plugins\codex-hongguo\bin\codex-hongguo.mjs setup --marketplace .
```

安装完成后在新的本地对话打开播放器，并在 Codex「设置 → Hooks」审查三个事件。不会自动写入信任。安装和更新前先关闭已有播放器与分屏。离线更新重复上面的命令，将当前目录切换到新版解压目录。

从实际安装副本检查环境：

```powershell
& "<实际插件根目录>\bin\run-node.exe" check
```

`HONGGUO_NODE` 可指定 x64 `node.exe` 的绝对路径；设置后不会静默回退到其他 Node。未设置时会检查绝对 PATH 项、常见 Node、Volta、nvm-windows 和 Scoop 安装位置。`HONGGUO_FFMPEG` 与 `HONGGUO_CODEX` 可覆盖工具路径，后者允许 `.exe`、`.cmd`。这些变量必须能被 Codex 子进程读取，仅在安装终端中设置并不能保证桌面继承。

进度与缓存位于 `%LOCALAPPDATA%\CodexHongguo\`；缺少该变量时使用 `%USERPROFILE%\AppData\Local\CodexHongguo\`。卸载保留该目录。

## 实现与自动化

- MCP 清单调用 `./bin/run-node`。macOS/Linux 执行原有 POSIX 脚本；Windows 将同名入口解析为 `run-node.exe`。Hooks 的 `commandWindows` 显式调用该 exe。
- Windows 启动器只负责 Node 发现、版本与 SQLite 检查、stdin/stdout 透传和退出码。使用 Windows Job 管理 Node 及其子进程，宿主终止启动器时回收运行时。
- Codex/npm 的 `.cmd` 调用通过 cross-spawn 处理；程序发现兼容 `PATH`/`Path`、带引号目录、中文与空格，忽略相对 PATH 项。
- Setup 和隔离安装结束时清理自己启动的 CLI 子进程树；ZIP 显式保存 POSIX 入口的执行权限，Windows 上打包也沿用相同权限。
- `npm run build` 使用 Go >=1.25 交叉编译 Windows x64 启动器，无 CGO 和第三方 Go 模块。Go 只用于源码构建，使用发行包无需安装。
- `ci.yml` 在 macOS、Linux、Windows 运行构建、回归、打包与隔离安装；发布 workflow 依赖这三项任务。Windows 隔离验证仅对临时测试仓库设置 `npm_config_force`，以验证尚未开放的平台产物，不代表 npm 平台限制已经解除。
- 安装验证覆盖 npm 来源迁移、重复更新、进度保留、MCP 启动、三个 Hook 写入、片库与分集、卸载保留数据。`--playback` 额外通过真实分集和 FFmpeg 解码检查媒体；无显卡时应回退 `libx264`。

## 开放 npm 前的验收

在 Windows x64 Codex 桌面使用带中文和空格的用户/安装路径完成以下观察，并记录 Windows、Codex、Node 和 FFmpeg 版本：

1. 离线安装与 Setup：能发现 MCP、播放器资源和三个待审查 Hooks；未信任时不显示回合联动已就绪。
2. 实际播放：选剧、HEVC/非 AAC 素材转换、静音/出声、跳转、换集，以及无硬件编码器时的软件回退。
3. 保存与续播：退出 Codex 后重新打开，确认剧集、播放位置和设置恢复。
4. 回合联动：信任三个 Hooks 后，在真实任务自然完成和手动中断两种情况下观察播放器暂停；后台面板也应暂停，之后可手动续播。
5. 更新与卸载：重复更新、从旧 ZIP 迁移、卸载后保留观看数据；重新安装后仍可续播。

自动化通过只证明相应运行路径，不能替代画面、声音与自然回合事件观察。上述桌面验收完成后，才将 `scripts/package.mjs` 的 `os` 增加 `win32`、更新支持状态并发布新版本。

## 本次本地验证（2026-11-06）

在 macOS arm64、Node 26.11.0、Go 1.25.4、FFmpeg 9.0.2、Codex CLI 0.157.1 完成：53 项回归中 50 项通过、3 项 Windows 专用测试跳过；构建与打包；真实隔离 npm 安装/更新/卸载、三个 Hook 状态写入、进度保留、宿主 MCP/片库/分集，以及真实分集分段传输后的 FFmpeg 解码。系统原生解压另验证了 ZIP 执行权限与 Hook stdin。

Windows x64 PE 启动器已交叉编译成功；Windows CI、Windows 桌面播放和自然回合暂停尚未执行。验收副本以当前 0.0.17 源码为基线，未提交、未发布 Windows 改动。为避开并行 UI 工作的产物，试用 ZIP、tgz、哈希绑定的安装回执和测试摘要单独存于 `release/windows-preview/0.0.17/`。
