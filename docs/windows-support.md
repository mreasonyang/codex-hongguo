# Windows 安装与验证

从 0.0.29 起，npm 包支持 Windows x64。使用 x64 Node.js >=22.16（含 npm 和 `node:sqlite`）以及支持 npm 插件源的 Codex CLI；无需 WSL、Git Bash、`sh` 或自行安装 FFmpeg。Windows ARM64 原生 Node 暂不支持。

## PowerShell 安装

```powershell
npx.cmd "@kyun.si/codex-hongguo@latest" setup
```

包名引号必须保留。未引用的 `@kyun.si/...` 会被 PowerShell 当成展开表达式，报 `SplattingNotPermitted`，此时安装程序尚未运行。`npx.cmd` 直接调用 npm 的命令入口；无需修改 PowerShell 执行策略。解析规则见 [Microsoft 文档](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing)。

安装程序自动下载、校验并缓存 Windows 播放组件。安装完成后，在 Codex「设置 → Hooks → 红果短剧」人工审查、信任并启用 `UserPromptSubmit`、`Stop`、`Interrupt`，然后打开新的本地聊天。安装程序不读取或写入信任记录。

更新前关闭播放器与分屏，然后运行：

```powershell
npx.cmd "@kyun.si/codex-hongguo@latest" update
```

更新保留进度和设置。卸载会删除本插件的播放组件、观看进度、设置、视频缓存和设备档案：

```powershell
npx.cmd "@kyun.si/codex-hongguo@latest" uninstall
```

若 npm 报 `EBADPLATFORM`，确认使用的是 0.0.29 或更新版本；旧发行包仅声明支持 macOS/Linux。无需使用 `--force` 绕过平台检查。

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

- Windows 使用原生 `run-node.exe` 启动 MCP 和 Hooks，启动器寻找 x64 Node、检查版本和 SQLite，并透传 stdin/stdout 与退出码。宿主终止启动器时通过 Windows Job 回收 Node 及子进程。
- `HONGGUO_NODE` 可指定 x64 `node.exe` 的绝对路径；设置后不会静默回退。未设置时检查绝对 PATH 项、常见 Node、Volta、nvm-windows 和 Scoop 安装位置。
- `HONGGUO_FFMPEG` 与 `HONGGUO_CODEX` 可覆盖程序路径，后者允许 `.exe`、`.cmd`。变量必须能被 Codex 子进程读取；仅在安装终端中设置不能保证桌面继承。
- 进度与缓存位于 `%LOCALAPPDATA%\CodexHongguo\`，缺省为 `%USERPROFILE%\AppData\Local\CodexHongguo\`。卸载删除这些数据；只想暂时停用时在 Codex 中禁用插件。
- 源码构建需要 Go >=1.25 交叉编译 Windows x64 启动器；使用发行包不需要 Go。

## 自动化与桌面观察

`ci.yml` 在 macOS、Linux、Windows 执行构建、回归、打包和隔离 npm 安装。Windows 安装验证不设置 `npm_config_force`，并分别在 Windows PowerShell 5.1 和 PowerShell 7 中执行带引号的 `npx.cmd` 命令；同时覆盖中文及空格路径、原生启动器、MCP 资源、Hooks 状态写入、更新保留进度与完整卸载。发布 workflow 依赖三平台验证通过。

自动化不能代替桌面画面、声音和自然回合事件观察。在 Windows Codex 桌面仍需独立记录以下结果：

1. 选剧、静音/出声、跳转、换集、HEVC/非 AAC 转换，以及无硬件编码器时的软件回退。
2. 退出 Codex 后重新打开，确认剧集、播放位置和设置恢复。
3. 人工信任三个 Hooks 后，在真实任务自然完成和手动中断时观察前台及后台播放器暂停，并检查手动续播。

当前修改的三平台 CI 结果与发行状态以对应提交的 Actions 和 npm registry 为准；桌面观察尚未作为自动化结果宣称通过。
