# Bilibili 番剧 Provider 验收

结论：本地实现与候选包 PASS。使用公共 npm SDK `@ikenxuan/amagi@6.6.0`，没有引入 Python。用户已安装插件未更新，没有推送或公开发布。

## 已完成

- 默认仍只有红果启用。设置开启哔哩哔哩后，通过左上角浮层选择来源；停用后退回红果，并撤销旧来源缓存播放授权。
- 接受原站番剧 ss/ep 链接或编号，添加后保存季度列表；正片有序分页，排除预告、花絮。链接仅在点击添加或回车时提交，红果保留原有输入搜索行为。
- SDK 通过公开请求适配器使用宿主的域名、体积、超时及取消限制。仅显式配置的账号 Cookie 可进入 B 站 API 请求；不读取浏览器或账号存储，不向 CDN、MCP、界面、日志或 Provider 数据库传递 Cookie。
- 支持完整普通 MP4 和 AVC/AAC 双轨。双轨有共享 256 MiB 预算、有限备用 CDN 重试和本地 FFmpeg 合流。试看、地区限制、权限不足及 DRM 有明确错误。
- amagi 独立构建、按需加载，避免其 Zod 依赖图影响默认红果/MCP 启动。组合发行包标注 GPL-3.0-only，保留原有 MIT 声明，附该项目对应源码和固定修订的 amagi 原始源码。

## 证据

- `npm test`：196 项，190 通过、6 项 Windows 专用跳过、0 失败。
- 真实匿名 SDK + 编译 MCP：`ss2251` 返回《玲音》13 集；首集时长 1,436,992 ms，媒体文件 90,293,597 bytes，样本冷缓存准备 17 秒。
- 首集 0 秒、600 秒、1,431 秒处真实音视频解码通过；319,085 bytes 的面板初始化段和首个媒体分片通过 MCP 分块读取后解码通过。
- MCP 服务重启后已添加季度和 30 秒进度保留；红果历史为空且 B 站历史独立；真实试看样本 `ss33073` 拒绝准备；停用来源后旧缓存不可继续授权。
- 内置 Browser：真实 MP4 播放，从保存位置恢复；拖到第一集片尾后自动准备并播放第二集；模拟所属回合 Stop 后暂停；设置停用 B 站退回红果，重新启用可从浮层切回。
- 最终构建第二集实播：`browser-playback.json`，视频 readyState=4、paused=false、error=null；截图见 `bilibili-playback.png` 和 `bilibili-source-popover.png`。
- `npm run package` 与 `npm run verify:install -- --playback` 通过：隔离 npm 安装、重复安装、真实红果片库、真实红果分集经 MCP 传输和解码、进度/设置保留、卸载及重复卸载。未调用系统 FFmpeg，也未改变用户当前插件安装。
- `artifacts.json` 记录本地候选包、运行产物及源码归档的 SHA-256；源文件对应当前分支的本次功能提交。
- 最终候选包另外直接运行了一遍 B 站真实 MCP 媒体资格检查，样本冷缓存准备 15 秒；`packaged-bilibili.json` 和 `installed-hongguo.json` 都为 PASS，并绑定到同一个最终 npm 包 SHA-256。

## 明确边界

首播仍先缓存整集，15–17 秒是本次样本结果，不是性能保证。支持原站普通非 DRM 番剧，不提供关键词搜索、追番同步、BV 投稿或短链。会员账号及地区受限内容未用真实账号验收。B 站浏览器实播和编译 MCP 媒体链路已验证；Codex 主窗口内的 B 站视频渲染、Windows/Linux 原生桌面未验收。临时服务与约 180 MB 的测试媒体已在验收后清理。

重跑：先 `npm ci --ignore-scripts && npm run build`，再运行 `node --no-warnings scripts/verify-bilibili.mjs`。脚本仅记录状态、计数和时长，默认清除临时媒体；不会获取或打印账号 Cookie、签名地址或原始子进程日志。
