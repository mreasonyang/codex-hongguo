# Windows 卸载修复验证

## 版本与范围

- 开始排查时源码为 `0.0.32`；最终补丁仍保留该版本号，尚未发布到 npm。
- 补丁基于 `main` 的 `8abe684`，保留默认本机 npm 市场索引、不依赖 Git 的设计。
- 按用户确认的方案，卸载器只做运行检测，不自动结束进程。

## 最终行为

1. 任何插件移除、市场注销或数据清理之前，检查插件缓存目录中启动器的运行状态。只读取 PID 和可执行文件路径，不读取进程参数、环境或原始日志。
2. 发现本插件仍运行时，明确提示关闭红果及相关 Codex 会话后重试；缓存、市场注册和观看数据保持原状。无法确认运行状态时同样停止卸载。
3. 确认未运行后，移除插件，注销本插件管理的市场并确认注册已消失，最后清理数据。市场位置同时兼容 `marketplaceSource.source` 和 `root`，并兼容 Windows 路径别名。
4. 若移除插件时仍出现文件占用或权限错误，返回明确的固定提示，保留观看数据，不转发宿主原始日志。外部自定义市场保持注册；重复卸载可成功完成。

## 测试结果

本地构建成功，以下回归测试 **19 项通过、0 失败**：

```sh
npm run build
node --test --test-timeout=30000 test/uninstall.test.mjs test/uninstall-data.test.mjs test/distribution.test.mjs test/setup.test.mjs
```

原生 Windows x64 与 Windows 11 ARM64 均通过隔离测试，使用各自原生 Node.js 24、Go 1.25 和固定 Codex CLI `0.157.1`。实际执行的源码提交为 `b243afd5a6f9b4ff411fe0eb118a3ccfeb1ca394`，结果见 [GitHub Actions 42209848875](https://github.com/mreasonyang/codex-hongguo/actions/runs/42209848875)。测试代码和运行时代码在整理独立 workflow 时未修改。

覆盖内容：

- 真实启动器及 SQLite 后台运行时调用卸载，验证尚未执行任何 Codex 卸载步骤，进程、缓存、市场注册和数据库均保留。
- 模拟用户关闭该测试插件后，使用真实 Codex CLI 完成缓存移除、仅有 `root` 的市场注销和数据清理。
- 限制 PATH 并确认 `git.exe` 不可执行，在此环境中完成卸载和真实 CLI 入口的重复卸载。
- 插件缓存外的同名启动器、其 Node 子进程以及独立 Node 进程始终继续运行。
- 单元测试同时覆盖预检失败、占用错误、市场注销失败、外部市场保留及安全错误提示。

长期入口为 `.github/workflows/windows-uninstall.yml`；原有 `windows-hooks.yml` 保持 Hooks Shell 回归用途。所有 Windows 测试均使用临时独立用户目录与 Codex 配置，未操作本机实际安装。以上为隔离卸载验证，不代表 Codex 桌面播放或自然 Hooks 的人工验收。
