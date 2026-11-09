# Provider 插件

播放器通过统一适配契约访问 Provider。内置红果和 Bilibili 番剧，本地插件通过同一注册入口加载。首版 API 为 1。

## Bilibili 番剧

内置红果和哔哩哔哩默认可用；悬停左上角图标后点击切换，无需开启设置。首页直接浏览番剧推荐，也可搜索番名、点击结果选择分集。搜索框兼容 `ss2251`、`ep50188` 或 `https://www.bilibili.com/bangumi/play/ss2251`，不必先添加链接。已导入的季度仍保留在本机，正片与预告、花絮分开，进度及缓存与红果隔离。聊天中的推荐、继续观看、回合内固定剧目和可见播放器抑制规则复用红果机制；推荐目录来自 B 站番剧索引，不发送红果的默认补充搜索词。

通过固定的公共 npm SDK `@ikenxuan/amagi@6.6.0` 获取季度、分集和按集播放流，使用 SDK 的公开 Axios adapter 接入宿主有域名、大小、超时及取消限制的请求器。不依赖 Python。SDK 的接口变化由上游跟进，本项目负责 Provider 映射、版本升级及回归。

番名搜索使用 amagi 的 WBI 签名器和受限 HTTP 传输；番剧搜索、公开索引两个 web 操作由本项目的 SDK 边界补齐，不另行实现签名算法。搜索和目录有短期缓存、分页、取消及限流错误处理。暂不提供 `b23.tv` 短链、UGC/BV 投稿或追番同步。默认使用匿名访问；在播放器设置底部「片源账号」分组中点击「哔哩哔哩」紧凑列表行（或在需要登录、仅提供试看的播放提示旁点击「登录片源账号」），即可进入单独的扫码登录子页并使用哔哩哔哩 App 扫码确认，不在设置列表原地展开二维码。二维码约三分钟过期，失败或过期可刷新重试；点击「返回设置」「取消登录」或按 Esc 会取消当前扫码并返回主设置页，关闭设置也会取消当前二维码。确认成功后自动返回主设置页，在账号行显示昵称和会员状态，重启及其他聊天共用本机登录态；再次点击已登录的账号行可进入账号管理并退出登录。退出登录只清除本播放器的登录态，不退出其他浏览器或设备。

登录态单独保存到 Provider 目录的 `account/session.json`，采用原子替换；POSIX 下目录权限为 0700、文件为 0600。不会读取浏览器 Cookie；Cookie 不进入界面、MCP 结果、媒体 CDN、日志或通用进度数据库，扫码链接及票据只在当前登录过程使用，不落盘。只有本人在手机确认后取得的登录态通过 B 站账号接口验证成功，才会保存。会员、地区、购买及 DRM 限制仍以原站和播放器支持能力为准。

已有的 `HONGGUO_BILIBILI_COOKIE` 启动环境配置仍可作为未保存账号时的兼容入口；扫码登录后的本机状态优先。退出后会保存空记录，阻止旧环境配置在重启后自动恢复登录。卸载清理包含此专用账号目录。

只有完整、非 DRM 的普通 MP4 或 AVC/AAC 双轨可以播放。试看即使返回成功状态也明确拒绝。提供 SIDX 的标准双轨走按需播放：宿主读取小型索引，面板及分屏通过本机受限传输获取当前位置附近的片段，MSE 分别追加音视频；首播、深度续播和跳转都不需要先下载整集。CDN 地址、请求头和原始字节范围留在宿主，不进入面板。片段缓存上限 128 MiB，每个片段不超过 32 MiB，备用 CDN 有限重试；无分段索引的单文件等兼容片源沿用原有整集准备路径。两小时以上及预算不合适的流会拒绝。自动下一集、回合暂停、替身移出暂停和返回恢复沿用共享播放器的控制逻辑；分段加载器不发起自动播放，关闭后丢弃晚返回的数据。红果仍使用原有媒体缓存与 HLS 链路。

登录后使用 amagi 原生账号检查、WBI 签名和大会员选流流程；其内部请求也通过当前 Provider 的受限传输，不再固定走匿名 H5 参数或 480p。播放器从原站授权返回的完整片源中优先选择预算内较高清晰度的 AVC/AAC，超过大小限制时降档；这不代表支持所有 4K、HDR、杜比或 DRM 格式。匿名访问保持原有选流策略。媒体缓存绑定不含凭据的账号版本，登录后重试原先的试看失败与低清晰度缓存，退出或切换账号后不能复用旧账号缓存；准备期间变更账号的结果不会发布。大会员分支已完成模拟账号的真实 SDK、双轨合流及音视频解码自动验证；真实会员专属番剧尚无会员账号实测。

项目采用 AGPL-3.0-only，完整文本见根目录 `LICENSE`。amagi 保留 GPL-3.0-only（`COPYING`）；两种许可证的第 13 条允许组合使用，AGPLv3 的网络交互义务适用于组合程序。历史 MIT 版本的授权继续有效，说明见根目录 `NOTICE`。发行包附带该项目的对应源码 ZIP、固定上游修订的 amagi 原始 TypeScript 源码和校验值；详见包内 `licenses/amagi/NOTICE.txt`。本地源码采用的 npm 依赖和 SDK 版本由锁文件固定，不维护 SDK fork。

## 默认启动与 NSFW 确认

已安装、发现且清单允许启动的 Provider 默认启动，不再提供播放器启用开关或保存 `enabledProviders` 列表。旧版启用列表会迁移清理，其他设置、登录态和观看进度保留。初始选中的片源仍为红果。

清单的 `nsfw` 是布尔值，省略时兼容为 `false`。红果和哔哩哔哩均显式声明 `nsfw: false`。从左上角浮层选择普通片源会直接切换；选择 `nsfw: true` 的片源时显示确认对话框。只有点击「确认切换」才保存源并执行切换；取消、Escape、关闭播放器或替身遮盖会取消本次选择。取消本身不会暂停旧片源或改变进度。每次重新切入 NSFW 源都需要确认，不保存永久豁免。

服务端 `set_source` 对 NSFW 切入要求 `confirmNsfw: true`，未确认请求不改变当前源或媒体授权。新聊天不会自动恢复上次的 NSFW 默认源，也不会从旧推荐自动切入 NSFW 源；需由用户重新选择并确认。普通片源的默认源恢复、首页及聊天推荐逻辑不变。

启动失败只使该插件不可用，不影响其他片源；修复后重新打开连接服务的聊天。`get_providers` 返回 `nsfw`、安装/发现状态、`enabled`、`available` 和固定错误代码。SDK 仍可在首次实际请求时延迟加载。

## 安装本地插件

在启动 MCP 服务的环境中显式设置 `HONGGUO_PROVIDERS_DIR` 为插件父目录。目录本身及插件入口不能是符号链接；插件只在服务启动时发现，增删后重新打开连接该服务的聊天。

```text
my-providers/
  my-source/
    provider.json
    index.mjs
```

`provider.json`：

```json
{
  "apiVersion": 1,
  "id": "my-source",
  "name": "我的片源",
  "version": "1.0.0",
  "entry": "index.mjs",
  "nsfw": false,
  "network": {
    "api": ["api.example.org"],
    "media": ["media.example.org", "*.cdn.example.org"]
  }
}
```

`id` 使用小写字母开头的字母、数字、连字符，最长 32 字符；内置 `hongguo`、`bilibili` 不允许被覆盖。`entry` 必须是插件目录内的 `.mjs` 文件。清单的 `enabled: false` 仍可由插件维护者禁止加载该入口；移除此清单限制并重启服务后即默认启动，没有播放器启用开关。

这是显式加载的可信本地 Node.js 代码，不是沙箱。清单、路径、导入、工厂和接口错误会隔离为该插件的不可用状态；清单校验无法防止插件代码主动退出进程或耗尽资源。应只安装自己审查过的插件。

## 入口与契约

可选扫码登录能力：清单声明 `authentication: "qrcode"`，Provider 同时提供 `auth.status()`、`auth.start(owner)`、`auth.poll(owner, loginId)`、`auth.cancel(owner, loginId)` 和 `auth.logout()`；缺少实现时该 Provider 启动失败，不影响红果。对应 `get_provider_auth`、`start_provider_login`、`poll_provider_login`、`cancel_provider_login` 和 `logout_provider` 均为仅供应用界面的工具。上游 Cookie、响应头和票据必须在 Provider 内部处理，界面只能获得账号显示信息、生成的二维码图像和当前面板绑定的本机登录标识。可选 `auth.revision()` 返回不包含凭据的版本标识，宿主据此撤销其他面板的旧播放授权。

入口导出 `createProvider(context)`，可以返回对象或 Promise。对象的 `id` 必须匹配清单，并实现以下五个方法：

```js
export function createProvider(context) {
  return {
    id: context.id,
    async listSeries({ query = '', cursor, pageSize, signal } = {}) {
      // 返回 { items: [{ id, title, description, episodes, coverURL? }], cursor: null | string }
      // 使用原站 ID，cursor 应绑定片源、操作和查询；不能保存播放签名。
      return { items: [], cursor: null }
    },
    async getSeries(rawSeriesId, { signal } = {}) {
      throw new Error('Implement provider metadata lookup')
    },
    async listEpisodes(rawSeriesId, { cursor, pageSize, signal } = {}) {
      // 返回 { items: [{ id, number, label, codec: '', playable: true }], cursor: null | string }
      return { items: [], cursor: null }
    },
    async getCover(rawSeriesId, { url, signal } = {}) {
      // 返回 { bytes: Uint8Array, mime?: string }，或 null。
      // 片源专用的图片解码应在这里完成，共用封面服务再缩放输出。
      return null
    },
    async resolvePlayback(rawEpisodeId, { signal } = {}) {
      // 仅在 Host 内传递；不向界面暴露源地址和授权信息。
      return { candidates: [] }
    },
    async dispose() {
      // 可选：关闭 SDK、文件和后台任务。
    },
  }
}
```

列表中的原站 ID 为非空字符串，最多 96 UTF-8 字节。Provider 自己保留分集与所属剧目的映射。宿主生成可跨平台作为文件名的限定 ID：`p.<provider>.s.<base64url>` / `p.<provider>.e.<base64url>`；现有红果 `hg-*` 保留原格式。

`context` 提供：

- `id`、`apiVersion`：插件身份与接口版本。
- `dataDir`：插件专属状态路径，位于宿主 `device/providers/<id>` 下，卸载时按现有数据策略清理。
- `signal`：服务关闭时中止。插件需要把它与单次请求的 signal 合并使用。
- `fetch(url, options)`：按清单 API 域名、每次跳转、大小和时限校验；返回 Response。默认上限 2 MiB、10 秒。
- `fetchMedia(url, budget, timeout, redirects, range)`：按媒体白名单获取，返回 `{body, limit, url}`；媒体处理器会计入预算。
- `mediaFetcher(headers)`：创建带固定请求头或 `targetURL => headers` 回调的媒体获取函数，用于 Referer / User-Agent 等片源要求。

宿主会限制清单和导入路径、发现数量，以及导入和工厂耗时。异步工厂出错、缺少方法或版本不支持时，该插件不出现在可选片源中；`get_providers` 可查看固定错误代码。一个插件不能覆盖已注册插件。

Provider 请求有宿主超时与结果失效保护。插件应主动响应 signal；宿主丢弃晚到结果不等于第三方 SDK 的底层网络已取消。

清单可选声明 `queryMode: "link"`、`queryHint` 和 `emptyMessage`（提示文字各不超过 160 字符）。链接模式只在点击添加或回车后提交，输入过程中不触发搜索。返回的 Provider 可声明 `discovery: false`，由其 `listSeries()` 提供自己的已添加列表；宿主不会用红果推荐关键词补充该列表。

## 播放描述

`resolvePlayback` 返回 `{ candidates, fetchMedia? }`，候选按顺序尝试：

```js
{ kind: 'file', url, codec: 'h264' }
{ kind: 'file', url, codec: 'hevc', encryption: { kind: 'cenc', key } }
{ kind: 'hls', url, codec: 'h264' }
{ kind: 'dash', url, codec: 'h264' }
{ kind: 'tracks', video: { url, backupURLs: [] }, audio: { url, backupURLs: [] }, codec: 'h264' }
```

`key` 仅为 Host 内部授权值，不是日志或 MCP 字段。CENC 授权通过 FFmpeg 标准输入传递。HLS AES-128 的 key 和 IV 从清单逐分片解析，不能用 CENC `encryption` 字段替代。

若未提供 `fetchMedia`，注册表使用清单媒体白名单生成的获取器。需自定义媒体请求头时，可返回 `fetchMedia: context.mediaFetcher(headers)`。严禁在候选或错误日志中附带个人账号配置；不要输出原始异常、播放地址、密钥或签名。

首版支持明文 MP4、CENC MP4、明文 VOD HLS/DASH 和 MPEG-TS AES-128 HLS。加密 HLS 支持显式 IV、media sequence 默认 IV、key 轮换，包括相同 URI 的新 key；加密 map、加密 byte range、discontinuity、SAMPLE-AES、DRM 和直播会明确拒绝。

媒体签名失效时宿主会重新解析一次，丢弃本次未提交的准备结果；其他错误不会无限重试。浏览器与 Codex 面板继续使用本地媒体路径及会话授权，不直接访问上游 CDN。

## 验证

```sh
npm test
npm run verify:install -- --playback
```

全量测试包含内置红果契约、本地示例插件默认启动/失败/重启、NSFW 元数据与确认/取消、旧设置迁移、来源隔离、切源竞态和通用 HLS 解密。`verify:install -- --playback` 在隔离安装中验证红果片库与媒体链路；不等于 Codex 主窗口实播。
