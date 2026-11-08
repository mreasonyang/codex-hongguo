# 替身网址保存后立即应用

日期：2026-11-08（Asia/Shanghai）；分支：`feat/hover-decoy-page`。

## 问题与修复

原实现把目标网站 origin 直接写入播放器资源的 iframe 策略。已打开的页面不能自行放宽这项策略，因而首次设置网址或改换域名时只能保存配置、等待重新打开。用户反馈了开启悬停模式后新 URL 不立即显示的问题。

现在播放器只嵌入本插件的固定本机展示来源。保存设置后，服务返回一个仅展示用的内存授权地址，前端只替换替身 iframe，保留播放器、视频对象、进度和播放状态。新展示页为目标网站生成精确的 `frame-src`；改变网站不再需要改变或重建播放器的宿主策略。嵌入页面使用自己的 CSP 的机制见 [OpenAI 官方说明](https://developers.openai.com/plugins/guides/security-privacy)，指令语义见 [MDN frame-src](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/frame-src)。

展示地址只经隐藏的工具数据传给界面，不持久化到设置或写入日志。旧地址在更换网址、清空网址或关闭功能后撤销；展示页不包含脚本，不代理抓取网站，也不授予播放、进度或其他 API 权限。播放器只放行自己的精确本机来源，展示页只放行对应的目标 origin。服务退出时会一并关闭本机监听。

界面文案已改为“保存后立即应用”。目标站本身禁止 iframe 或不兼容嵌入环境时仍可能无法显示；清空网址立即恢复内置工作笔记。

## 验证

- 全量回归：166 项，160 通过、0 失败、6 项 Windows 专属检查跳过；见 [test-summary.json](test-summary.json)。
- 回归覆盖：同一播放器连续保存两个不同网站、相同网址保存不重载替身、清空网址、保留视频实例与播放状态、精确目标 CSP、旧展示授权失效、授权不进入数据库，以及 stdin 关闭后 MCP 正常退出。
- 内置浏览器运行正式构建 HTML、真实 BrowserServer/Service/SQLite 与本地测试视频：同一页面先保存第一个测试站点，再保存不同端口的第二个站点，两次均直接显示对应页面，全程未刷新或重新打开播放器。
- 第一次保存前后视频时间从 5.228 秒继续到 16.141 秒，第二次从 23.464 秒继续到 26.626 秒，两次保存后都处于播放状态；清空网址后内置替身立即显示。见 [observations.json](observations.json)。
- `npm run package`、`npm run verify:install` 均通过；隔离安装验证回执位于本地 `release/verification.json`。
- 已更新用户日常 Codex 的本地安装（版本标记仍为 0.0.34）。播放器、服务与 Hooks 文件和候选逐字节哈希匹配；播放环境检查通过，现有悬停开关及自定义网址保留。仅记录布尔状态，不记录用户网址或展示授权地址。见 [本地安装回执](local-install.json)。

浏览器测试不等于真实 Codex MCP App 主窗口实机验收。本次修复涉及宿主资源版本从 v20 升至 v21；安装修复后，已有旧播放器需关闭并在新聊天重开一次以加载新代码，之后更换网址均直接应用。

![同一播放器保存第二个网站后直接显示新页面](second-website.jpg)
