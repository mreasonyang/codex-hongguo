# 开发与维护指南 (Contributing)

本文档承接 `codex-hongguo` 的本地构建、自动测试、内测包打包、安装验证及版本管理规则。日常使用与安装说明见 [README.md](README.md)（英文版见 [README.en.md](README.en.md)）。

## 开发环境要求

- **Node.js `>= 22.16`**：服务端与 Hook 写入器使用 Node 内置的 `node:sqlite`。
- **FFmpeg**：建议使用 `8` 或以上版本，用于红果整集重封装、CENC 单文件解密重封装、面板 HLS 分片生成、HEIC/封面缩放转码以及本地媒体回归测试。
- **Codex CLI (`codex`)**：运行隔离安装验证（`scripts/verify-install.mjs`）时需本机可执行 `codex plugin` 与 `codex app-server`。

## 构建、测试、打包与安装验证

在源码根目录按顺序运行：

```sh
npm ci
npm test
npm run package
npm run verify:install
```

| 命令 | 脚本与行为说明 |
| --- | --- |
| `npm run build` | 校验版本、运行前端类型检查，用 esbuild 打包 MCP、Hooks、Setup 与 CLI 至 `dist/`，复制上游 SDK/WASM 并生成内联播放器 HTML。 |
| `npm test` | 构建后运行 41 项自动回归，覆盖媒体协议、解密转码、回合联动、安装迁移与失败恢复，媒体样本位于 `test/fixtures/`。 |
| `npm run package` | 生成完整 npm tgz、同产物离线 ZIP、待发布版本索引；截取中英文 README 消费者指南，并收集运行依赖许可证。 |
| `npm run verify:install` | 使用临时 HTTPS npm 仓库与独立 Codex 配置，验证真实 npm exec/npx 安装、原生 npm 源、重复更新、旧市场迁移、进度保留、24 个 MCP 工具、两个 UI 资源、片库/分集、3 个待信任 Hooks，以及卸载保留数据。输出绑定 tgz 哈希的验收回执。 |

> **注意**：中英文 README 必须保留 `<!-- development -->` 分界且其后内容非空。安装目录使用已通过宿主验证的 `.codex-plugin/plugin.json` 与 `.mcp.json`；便携清单保留在源码，避免 Codex 0.157.1 的 Hook 遮蔽问题。

## 版本号规则

- 版本号从 `0.0.1` 起，格式须为三段 `0`–`999` 的整数（由 [scripts/version.mjs](scripts/version.mjs) 强校验）。
- 发布下一版时运行：

  ```sh
  npm run version:patch
  ```

  该命令仅将第三位加一（例如 `0.0.3 → 0.0.4`），并自动同步 `package.json`、`package-lock.json`、[plugin.json](plugin.json) 和 [.codex-plugin/plugin.json](.codex-plugin/plugin.json)。
- 当第三位达到 `999` 时停止自动递增；调整前两位版本号须由项目维护者明确指定。
- 日常重新构建（`npm run build`）或重新打包（`npm run package`）沿用当前版本号，不递增版本。若手动修改后清单版本不一致，可运行 `node scripts/version.mjs --sync` 同步。

## 环境变量与调试参数

| 变量名 | 作用阶段 | 用途说明 |
| --- | --- | --- |
| `HONGGUO_DATA_DIR` | 服务运行 / 测试 | 指定隔离的数据与缓存目录（包含 `player.sqlite`、`media/`、`panel-media/`、`device/`），避免测试污染个人观看进度。 |
| `HONGGUO_NODE` | POSIX 启动器 | 显式指定 Node >=22.16 可执行文件；缺省自动寻找。 |
| `HONGGUO_FFMPEG` | 服务 / Setup | 指定 FFmpeg 可执行文件；缺省自动寻找，不写入发布包。 |
| `HONGGUO_CODEX` | 安装 / Setup | 指定 Codex CLI，用于原生插件安装及 hooks/list 状态回读。 |
| `HONGGUO_PROFILE_PATH` | 服务运行 | 指定上游 SDK 匿名设备档案位置。 |

在本地排查或编写测试时：

- 媒体密钥由 SDK 在内存中获取，并通过 FFmpeg 标准输入（`ffconcat` 管道）传给本机 `ffmpeg` 进程，禁止写入命令参数、日志或持久化文件。
- 本插件的 Hook 写入器（`src/hooks/write.mjs`）仅解析并记录 `session_id`、`turn_id` 和 `hook_event_name`（限 `UserPromptSubmit`、`Stop`、`Interrupt`），不保存 Hook 原始输入、提示词或回复；发生任何异常均静默返回 `{}`，不得阻塞宿主回合。
- Setup 检查逻辑（`src/server/setup.mjs`、`src/setup/check.mjs` 和 [skills/hongguo-setup/SKILL.md](skills/hongguo-setup/SKILL.md)）只按当前插件身份与安装路径过滤 `hooks/list` 的公开状态，绝不暴露原始 Hook 命令或宿主内部诊断信息，也不自动修改用户的信任配置。

## 发布与验证

当前 0.0.9 已通过 41 项自动回归、真实 npm/npx 隔离安装、0.0.8 ZIP 迁移、进度保留和 app-server 片库检查。本次安装验证未观测桌面视频画面及自然回合自动暂停；macOS 为本机验收平台，Linux 实机及 Windows 启动器仍待完成。完整发布流程及边界见 [npm 分发说明](docs/npm-distribution.md)。

完成测试、打包和安装验证后运行 `npm run release:publish`；该脚本只发布回执绑定的 tgz，回读 registry 完整性后才更新索引。首次发布需要 npm 登录，后续可配置受信任发布者并运行手动 Publish workflow。

## 参考规范与上游链接

- [OpenAI 插件扩展](https://developers.openai.com/plugins/build/extensions)
- [插件打包与分发](https://developers.openai.com/plugins/build/plugins)
- [Codex Hooks](https://learn.chatgpt.com/docs/hooks)
- [openhongguo](https://github.com/beilunyang/openhongguo)
- [dsh-hongguo](https://github.com/frostming/dsh-hongguo)
