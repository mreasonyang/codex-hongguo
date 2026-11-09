# Bilibili 扫码登录验收

分支：`feat/video-source-adapters`。本次没有更新用户已安装插件，也没有发布 npm 或合入 main。

## 实现

- 开启并保存哔哩哔哩后，播放器设置提供扫码登录、账号与会员状态、二维码刷新/取消和退出登录。中英文界面、390px 窄侧栏均已检查。
- 使用固定版本 amagi 6.6.0 的登录 API。二维码、票据和响应 Cookie 只在 Provider 内部处理；新版 crossDomain 票据只访问白名单 passport 域名及路径。
- 登录态通过账号接口验证后，原子写入 Provider 专用账号文件；POSIX 权限为目录 0700、文件 0600。退出记录覆盖环境变量兼容入口，重启不会恢复旧账号。其他聊天在下一次请求/轮询时同步，并撤销旧播放授权。
- 默认仍只启用红果。登录工具仅对应用界面开放；停用 Provider、取消二维码、关闭设置或面板会终止相应登录过程。

## 验证

- 全量自动测试：208 项，202 通过、6 项 Windows 测试跳过、0 失败，见 `tests.json`。
- 包内真实匿名二维码生成、等待扫码、面板归属校验、取消、退出和停用检查通过，见 `packaged-auth.json`。此项不代表真实账号已登录。
- 用户手机确认的真实普通账号已完成扫码登录、页面刷新恢复、独立包内 MCP 进程读取登录态、登录后分片解码和浏览器实播；视频 672×480、23:56，观察到播放进度超过 15 秒。退出后视频暂停并撤销来源，新 MCP 进程也返回未登录，见 `real-account.json`。不记录账号名、Cookie、登录二维码、认证链接、票据或原始日志。`real-account-playback.png` 只包含播放界面。
- 真实浏览器使用模拟账号完成扫码、状态展示、页面刷新后保留及退出。`qr-fixture-narrow.png`、`signed-in-fixture.png` 均为合成测试账号画面。
- 包内匿名《玲音》13 集，首集完整媒体 90,293,597 bytes、时长 1,436,992 ms；0/600/1431 秒解码、MCP 分片解码、续播、试看拒绝及停用撤销通过，见 `packaged-bilibili.json`。
- 最终包的 macOS 隔离 npm 安装、重复安装、真实红果播放解码、Hooks、进度保留、卸载及重复卸载通过，见 `installed-hongguo.json`。回执哈希与 `artifacts.json` 对应。
- AGPLv3 项目许可、amagi GPLv3 及二维码组件 MIT 声明已随包保留；附带源码的 114 个文件与工作区一致。

真实 Codex 主窗口账号控件渲染、Windows/Linux 原生桌面及会员/地区/DRM 内容可用性需要分别验收，不能由模拟账号或匿名播放推定。

复验：`npm test`、`npm run package`、`BILIBILI_VERIFY_PACKAGE_ROOT=release/npm/codex-hongguo node scripts/verify-bilibili-auth.mjs`、`BILIBILI_VERIFY_PACKAGE_ROOT=release/npm/codex-hongguo node scripts/verify-bilibili.mjs`、`npm run verify:install -- --playback`。
