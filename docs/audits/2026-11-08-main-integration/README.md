# main 集成回归

在 `feat/video-source-adapters` 合入 main `0a57f75b4806a6ddab8ea256c0991e05a559e9a3`，原功能分支为 `2eaee23249ec2711727c599f911807c57525f969`。未修改 main 工作区，未发布、推送或更新用户已安装插件。

## 设计保留与兼容处理

- 保留 main 的自动保存队列、关闭/外部点击/Esc 行为、紧凑帮助和替身样式选择。Provider 开关使用同一队列，保存与轮询不替换聚焦的开关；关闭设置取消扫码。
- 替身页、悬停逻辑、播放组件下载/锁超时、组件精简和 beta/stable 发布模块与 main 一致，见 `main-design-check.json`。
- 两个前置分支均使用数据库迁移编号 2，但迁移内容不同。统一到版本 3，以幂等方式补齐 Provider 推荐表与旧替身地址清理。测试覆盖 main v2（无 Provider 表）与 Provider v2，保留进度、设置和推荐，重复打开不丢数据。
- 新 UI 资源为 v31，保留旧 URI（含 v20–v30）。npm/离线包不包含截图，README 图片保留版本绑定链接；AGPL、第三方许可与对应源码继续附带。

## 验证

- `npm test`：319 项，312 通过、7 项平台条件跳过、0 失败。包含真实 Settings、ProviderAccount、Service 和 SQLite 组合测试。
- `python3 -m unittest discover -s test -p repack_ffmpeg_test.py`：5 项通过。
- Brave 原生界面：Provider 自动保存、禁用后刷新保持、重新启用、扫码关闭清理、浮层选源、替身样式自动保存、移出显示/指针返回恢复。仅使用临时配置，扫码界面使用合成账号夹具。见 `browser-check.json` 与截图。
- 最终 tgz 隔离安装/重复安装/进度保留/Hook 手动授权提醒/目录/MCP 片段/真实红果 FFmpeg 解码/卸载通过，见 `install-verification.json`。
- 同一最终包：真实匿名 B 站番剧 13 集；90,293,597 字节视频在 0/600/1431 秒解码通过；MCP 分片、重启续播、预览拒绝和禁用后的缓存失效通过，见 `bilibili-packaged.json`。
- 同一最终包：真实二维码生成、等待、所属面板校验、取消、退出及禁用后不能登录通过，见 `bilibili-auth-packaged.json`。无真实账号扫码。
- 包内对应源码 ZIP 解压到独立临时目录，`npm ci --ignore-scripts --no-audit --no-fund` 与 `npm run build` 通过，见 `source-rebuild.json`。

## 边界

未验证真实大会员专属内容（用户无可用会员账号）；会员分支由 SDK/接口模拟与真实媒体夹具回归覆盖。未进行新一轮 Codex 桌面真实视频播放、自然回合结束验收，未运行 Windows/Linux 实机或云端 CI。本地安装验收中的 `desktopPlaybackObserved` 为 false。版本 0.0.35 为本地合并候选包，不代表新的公共发布。
