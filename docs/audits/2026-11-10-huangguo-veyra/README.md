# 黄果 NSFW Provider：Veyra 接入

基线为 main `3a6d964` / 0.0.37；实现分支 `feat/huangguo-nsfw`。

- 从 Veyra `a83dfd9a29b23d439da4f853d104568696cd401c` 引入站点模块及封面解码，固定来源并保留 GPLv3、修改说明；本项目继续 AGPL-3.0-only。
- 默认注册 `huangguo`，启动时不访问站点或创建账号状态。切入使用现有 NSFW 确认，新聊天回到普通来源。列表、搜索、分集、封面、续播、缓存和面板授权复用 Provider 契约。
- 使用受限匿名请求器，保持 TLS 校验、域名与响应预算、超时和取消。媒体地址和密钥只在 Host 内，错误和验证回执不输出上游原文。
- 实测发现旧 GET `/play` 接口返回成功但播放地址为空，已适配 2026-11-10 新 POST `/episodes/<n>/playback`，使用 main/HEVC，拒绝只有 preview 或不支持的清单请求方法。
- 沿用通用 HLS AES-128 整集下载、解密和 MP4 重封装；没有增加按需 HLS 起播。

## 验证

[真实 MCP 回执](live-mcp.json) 绑定编译服务 SHA-256：目录 16 项、搜索 16 项、分集 21 项，封面解码通过；约 208 秒视频经 42 个面板资产、378 次 MCP 分块传输后完整解码音视频，历史隔离与续播位置检查通过。所有真实媒体和临时数据库已清理。

自动检查结果见 [tests.json](tests.json)。复现：

```sh
npm test
node scripts/verify-huangguo.mjs --live --playback
```

这次真实验证覆盖本机编译后的 MCP 服务，不代表用户已安装插件或 Codex 主窗口的画面、声音及自然 Stop/Interrupt 验收。未执行公开发布或替换用户安装。
