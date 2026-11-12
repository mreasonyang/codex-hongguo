---
name: hongguo-provider
description: 为红果短剧开发、验证、安装或修复本地视频 Provider。适用于用户提供网站、API 文档、现成客户端库或 npm 包，希望接入片源或排查实际播放失败。
---

使用本 Skill 所属插件的 CLI。入口在 [bin/codex-hongguo.mjs](../../bin/codex-hongguo.mjs)，用 Node.js 22.16 或更高版本运行。下文的 `codex-hongguo` 可替换为 `node <插件目录>/bin/codex-hongguo.mjs`。

按用户本次明确授权的范围开展开发和验收。发现宿主、CLI、内置片源或依赖的问题，不自动扩大任务；范围外问题单独记录。交付前按任务开始时的提交核对改动范围。

1. 确认站点支持的浏览、搜索或链接导入方式，运行 `codex-hongguo provider create <新目录> --template search|link --id <片源ID>`。脚手架自带 SDK、类型、清单 Schema 和本地有声样例；接入实际源时替换样例实现及媒体。保留稳定的原站身份；超长 ID、分集复合 ID 与原站游标按[稳定身份与分页](../../docs/providers.md#稳定身份与分页)处理。
2. 用户给了 API 库时，先读其公开入口、传输接口、媒体域配置和配套资源，按[接入现成 API 库](../../docs/providers.md#接入现成-api-库)适配并打包运行依赖。接入时保持给定版本的第三方源码不变，兼容处理放在自己的 Provider 或注入传输层，不能靠修改库或 vendor 副本让验收通过。直接接网站时，API 用 `context.fetch`，媒体用 `context.fetchMedia` 或 `context.mediaFetcher`。合并单次和宿主取消信号；有共享 SDK 客户端、探活或缓存 Promise 时，检查[取消与并发调用](../../docs/providers.md#取消与并发调用)的归属。签名链接、Cookie 和密钥留在传输层。
3. 运行 `provider test <目录>` 检查离线契约。网络适配的 `provider.fixture.mjs` 提供 `query`、可选的 `missingQuery` 及模拟传输；按原站页大小和游标返回数据。补验[工具未覆盖的行为](../../docs/providers.md#补充行为验证)：进行中的底层请求取消、并发调用互不误取消、新实例直接恢复历史 ID。不要把预取消或第二页不重复当作这些行为已通过。
4. 交付前按[安装副本隔离验收](../../docs/providers.md#安装副本隔离验收)，用全新临时 `HONGGUO_DATA_DIR` 安装，暂时移走自己创建的开发副本及外部依赖，再以新 CLI 进程运行 `provider doctor --installed <片源ID> --query <公开关键词或链接>`，最后恢复目录。`samples` 最多记录 3 个真实候选的跳过/选中情况；全局目录或分页失败不会被后续媒体成功覆盖。确认实际 API、媒体和解码均来自安装副本，不能用本地样片替代；只安装加载成功不足以证明运行依赖齐全。
5. 对 HLS 检查主清单、变体、独立音轨、初始化段、分片、AES 密钥和重定向域。`HOST_NOT_ALLOWED` 时根据库或上游配置补齐白名单；CDN 轮换时换一集或重新获取清单复查。诊断 `decode` 和 `audio` 分别表示实际采样；`hls-first-segment` 仅取首分片，`complete` 表示完整准备所选素材，两者都只解码首秒，不证明整集播放。保留 `unverified`。
6. 用 `provider preview <目录>` 在真实播放器检查选集、播放、跳转和续播；启动预览地址不算实播。未观察的交互如实标记。用户需要正式安装时再安装到目标环境；更新保持身份稳定、提高版本，执行 `provider update` 后复查新连接 `get_providers` 的实际版本，必要时 `provider rollback <id>`。

安装的 Provider 以可信本机 Node.js 模块运行。按[验收结果范围](../../docs/providers.md#验收结果范围)分别报告离线模拟、真实 API、安装副本媒体采样和播放器观察，附阶段证据及未验收项。
