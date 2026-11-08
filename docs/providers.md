# Provider 插件

播放器通过统一适配契约访问 Provider。内置红果和 Bilibili 番剧，本地插件通过同一注册入口加载。首版 API 为 1。

## Bilibili 番剧

在播放器设置开启「哔哩哔哩」并保存，悬停左上角图标后点击切换。输入 `ss2251`、`ep50188` 或 `https://www.bilibili.com/bangumi/play/ss2251`，点击「添加番剧」；选择分集后播放。已导入的季度保存在本机 Provider 专属目录，重启后保留；正片与预告、花絮分开，进度及缓存与红果隔离。

通过固定的公共 npm SDK `@ikenxuan/amagi@6.6.0` 获取季度、分集和按集播放流，使用 SDK 的公开 Axios adapter 接入宿主有域名、大小、超时及取消限制的请求器。不依赖 Python。SDK 的接口变化由上游跟进，本项目负责 Provider 映射、版本升级及回归。

首版不提供关键词搜索、推荐片库、`b23.tv` 短链、UGC/BV 投稿或追番同步。没有已添加番剧时首页显示链接导入提示。默认使用匿名访问；开启并保存哔哩哔哩后，在播放器设置的「B 站账号」点击「扫码登录」，使用哔哩哔哩 App 扫码并确认。二维码约三分钟过期，可刷新或取消；关闭设置会取消当前二维码。确认后显示账号名和会员状态，重启及其他聊天共用本机登录态。退出登录只清除本播放器的登录态，不退出其他浏览器或设备。

登录态单独保存到 Provider 目录的 `account/session.json`，采用原子替换；POSIX 下目录权限为 0700、文件为 0600。不会读取浏览器 Cookie；Cookie 不进入界面、MCP 结果、媒体 CDN、日志或通用进度数据库，扫码链接及票据只在当前登录过程使用，不落盘。只有本人在手机确认后取得的登录态通过 B 站账号接口验证成功，才会保存。会员、地区、购买及 DRM 限制仍以原站和播放器支持能力为准。

已有的 `HONGGUO_BILIBILI_COOKIE` 启动环境配置仍可作为未保存账号时的兼容入口；扫码登录后的本机状态优先。退出后会保存空记录，阻止旧环境配置在重启后自动恢复登录。卸载清理包含此专用账号目录。

只有完整、非 DRM 的普通 MP4 或 AVC/AAC 双轨可以播放。试看即使返回成功状态也明确拒绝。双轨通过 Provider 白名单传输下载、备用 CDN 有限重试、FFmpeg 本地合流后复用浏览器 MP4 和 Codex 面板 HLS；首次播放需先准备整集，单集原始媒体总预算仍为 256 MiB，两小时以上及预算不合适的流会拒绝。自动下一集、缓存预加载和回合暂停沿用宿主逻辑。

登录后使用 amagi 原生账号检查、WBI 签名和大会员选流流程；其内部请求也通过当前 Provider 的受限传输，不再固定走匿名 H5 参数或 480p。播放器从原站授权返回的完整片源中优先选择预算内较高清晰度的 AVC/AAC，超过大小限制时降档；这不代表支持所有 4K、HDR、杜比或 DRM 格式。匿名访问保持原有选流策略。媒体缓存绑定不含凭据的账号版本，登录后重试原先的试看失败与低清晰度缓存，退出或切换账号后不能复用旧账号缓存；准备期间变更账号的结果不会发布。大会员分支已完成模拟账号的真实 SDK、双轨合流及音视频解码自动验证；真实会员专属番剧尚无会员账号实测。

项目采用 AGPL-3.0-only，完整文本见根目录 `LICENSE`。amagi 保留 GPL-3.0-only（`COPYING`）；两种许可证的第 13 条允许组合使用，AGPLv3 的网络交互义务适用于组合程序。历史 MIT 版本的授权继续有效，说明见根目录 `NOTICE`。发行包附带该项目的对应源码 ZIP、固定上游修订的 amagi 原始 TypeScript 源码和校验值；详见包内 `licenses/amagi/NOTICE.txt`。本地源码采用的 npm 依赖和 SDK 版本由锁文件固定，不维护 SDK fork。

## 启用配置

默认只启动红果。本地插件在「播放器设置 → 片源 Provider」手动开启并保存后才创建实例；仅安装或发现插件不会执行它的入口。

启用列表保存在本机设置 `enabledProviders` 中，初始值为 `["hongguo"]`，保存后立即生效，并在服务重启后沿用。红果保持启用，作为其他片源停用或移除后的默认来源。旧设置没有启用列表时也按红果单源处理。

启用开关决定哪些 Provider 可以运行。启用两个及以上片源后，悬停左上角图标展开浮层，点击其中的片源才切换；点击图标也只打开浮层，不会直接切源或自动启用插件。浮层只列出已启用且启动成功的片源。停用当前片源时保存进度并回到红果；观看记录和缓存保留，停用源的旧分集入口及缓存播放不能继续授权。其他聊天在下一次请求或状态轮询时同步。

启动失败会显示「启动失败」，不影响红果；可关闭、保存后重新开启。`get_providers` 返回安装/发现状态、`enabled`、`available` 和固定错误代码。未启用时不执行工厂或发出 Provider 请求。

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
  "network": {
    "api": ["api.example.org"],
    "media": ["media.example.org", "*.cdn.example.org"]
  }
}
```

`id` 使用小写字母开头的字母、数字、连字符，最长 32 字符；内置 `hongguo`、`bilibili` 不允许被覆盖。`entry` 必须是插件目录内的 `.mjs` 文件。清单的 `enabled: false` 会禁止启动该插件；移除此限制后重新启动服务，才能在播放器设置中开启。

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

全量测试包含内置红果契约、本地示例插件发现/失败/启停/重启、旧红果兼容、来源隔离、切源竞态和通用 HLS 解密。`verify:install -- --playback` 在隔离安装中验证红果片库与媒体链路；不等于 Codex 主窗口实播。
