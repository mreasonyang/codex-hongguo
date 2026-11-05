# npm 分发

实现版本：0.0.9。首次公开 npm 发布仍需完成 npm 登录或配置受信任发布者。仓库当前 npm 包名为 `codex-hongguo`，GitHub 市场目标为 `mreasonyang/codex-hongguo`。

## 安装链路

`npx codex-hongguo@latest setup` 检查 Node、Codex CLI 和 FFmpeg，再调用原生 `codex plugin marketplace add` 与 `codex plugin add`。Git 仓库的 `.agents/plugins/marketplace.json` 只指向 npm 的确定版本，不存放构建产物。升级通过原生市场刷新完成。`update` 是相同流程的便捷入口。

完整 npm 包包含 `.codex-plugin/plugin.json`、`.mcp.json`、Hooks、Skills、预构建 MCP/CLI、播放器、上游 SDK/WASM 和许可声明。开发仓库保持 private package，公开包在 `release/npm/codex-hongguo` 单独生成；安装不运行生命周期脚本、不安装依赖树。项目未授予开源许可证，沿用 `UNLICENSED`，第三方依赖随附许可声明。

macOS/Linux 的 MCP 与 Hooks 通过包内 POSIX 启动器自动寻找 Node >=22.16，包括 PATH、Homebrew、Volta、nvm、mise、fnm 的常见安装位置；FFmpeg 与 Codex 只查已知程序目录或显式覆盖。当前 npm 包限制 `os` 为 darwin/linux；Windows 启动器与实机验证尚未完成。Linux 仅有程序逻辑覆盖，本次本机验收为 macOS。

向导沿用 `codex-hongguo@hongguo-local` ID。若之前来自本地 ZIP，只替换这个市场来源并重新安装；失败会尝试恢复原来源。它不清理观看数据、不修改认证配置，不写 Hook 信任。关闭旧面板后迁移，再打开新对话审查 Hooks。特殊运行时可使用 HONGGUO_NODE、HONGGUO_FFMPEG、HONGGUO_CODEX 指定程序。诊断只输出就绪元数据，宿主原始 stdout/stderr 不会转发到安装器日志。

## 构建与验收

```sh
npm ci
npm test
npm run package
npm run verify:install
```

打包输出：

- `release/codex-hongguo-<版本>.tgz`：准备发布的不可变 npm 包。
- `release/codex-hongguo-<版本>.zip`：同产物离线市场。
- `release/marketplace/.agents/plugins/marketplace.json`：发布成功后采用的版本索引。
- `release/verification.json`：真实安装回执，绑定 npm 包 SHA-256。

安装验证在临时 HOME/独立 Codex 配置中创建 HTTPS npm 测试仓库，用临时 CA 让原生 npm 下载校验证书，生产 registry 和 TLS 策略保持不变。它从离线市场迁移到 npm，检查观看进度和引导设置保留、待信任 Hooks、真实 app-server 的 MCP 工具/播放器资源、片库/分集和卸载后数据保留。可用 `node scripts/verify-install.mjs --previous-zip <旧版.zip>` 验证真实旧发行包到新版的迁移。

`npm test` 验证解密、HEVC/ALAC 转码、HLS/DASH、缓存及回合停止状态。以上不等同于真实桌面播放器的视频画面或自然回合自动暂停观测；回执中的 `desktopPlaybackObserved` 会明确保留为 false，不能把未信任 Hook 的隔离验证说成桌面端验收。

## 发布

先完成验收，在已登录且拥有包发布权限的终端运行：

```sh
npm run release:publish
```

脚本只发布回执绑定的 tgz，回读 npm registry 的 SHA-512 完整性后才更新仓库索引和 README 发布状态。首次发布可能需要 npm 的交互式双重认证；可在自己的终端直接发布已验收 tgz，再运行 `npm run release:publish -- --index-only` 完成完整性核验与索引更新。不要向聊天或仓库粘贴令牌。

后续通过 GitHub Actions 的手动 Publish workflow 发布。为 `codex-hongguo` 配置 npm 受信任发布者（仓库 `mreasonyang/codex-hongguo`，workflow `publish.yml`），CI 使用 OIDC，不保存 npm 长期令牌。版本升级使用 `npm run version:patch`，测试及打包仍沿用该版本。索引在 npm 发布成功后自动提交。
