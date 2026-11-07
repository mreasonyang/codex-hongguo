# Provider 插件

播放器通过统一适配契约访问 Provider。红果、黄果为内置插件；本地插件通过同一注册入口加载。首版 API 为 1，不需要修改 Catalog、播放器或媒体缓存才能添加来源。

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

`id` 使用小写字母开头的字母、数字、连字符，最长 32 字符；内置 `hongguo`、`hghub` 不允许被覆盖。`entry` 必须是插件目录内的 `.mjs` 文件。`enabled: false` 可停用插件而不执行入口。

这是显式加载的可信本地 Node.js 代码，不是沙箱。清单、路径、导入、工厂和接口错误会隔离为该插件的不可用状态；清单校验无法防止插件代码主动退出进程或耗尽资源。应只安装自己审查过的插件。

## 入口与契约

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

列表中的原站 ID 为非空字符串，最多 96 UTF-8 字节。Provider 自己保留分集与所属剧目的映射。宿主生成可跨平台作为文件名的限定 ID：`p.<provider>.s.<base64url>` / `p.<provider>.e.<base64url>`；现有红果 `hg-*`、黄果 `hh-*` 保留原格式。

`context` 提供：

- `id`、`apiVersion`：插件身份与接口版本。
- `dataDir`：插件专属状态路径，位于宿主 `device/providers/<id>` 下，卸载时按现有数据策略清理。
- `signal`：服务关闭时中止。插件需要把它与单次请求的 signal 合并使用。
- `fetch(url, options)`：按清单 API 域名、每次跳转、大小和时限校验；返回 Response。默认上限 2 MiB、10 秒。
- `fetchMedia(url, budget, timeout, redirects, range)`：按媒体白名单获取，返回 `{body, limit, url}`；媒体处理器会计入预算。
- `mediaFetcher(headers)`：创建带固定请求头或 `targetURL => headers` 回调的媒体获取函数，用于 Referer / User-Agent 等片源要求。

宿主会限制清单和导入路径、发现数量，以及导入和工厂耗时。异步工厂出错、缺少方法或版本不支持时，该插件不出现在可选片源中；`get_providers` 可查看固定错误代码。一个插件不能覆盖已注册插件。

Provider 请求有宿主超时与结果失效保护。插件应主动响应 signal；宿主丢弃晚到结果不等于第三方 SDK 的底层网络已取消。

## 播放描述

`resolvePlayback` 返回 `{ candidates, fetchMedia? }`，候选按顺序尝试：

```js
{ kind: 'file', url, codec: 'h264' }
{ kind: 'file', url, codec: 'hevc', encryption: { kind: 'cenc', key } }
{ kind: 'hls', url, codec: 'h264' }
{ kind: 'dash', url, codec: 'h264' }
```

`key` 仅为 Host 内部授权值，不是日志或 MCP 字段。CENC 授权通过 FFmpeg 标准输入传递。HLS AES-128 的 key 和 IV 从清单逐分片解析，不能用 CENC `encryption` 字段替代。

若未提供 `fetchMedia`，注册表使用清单媒体白名单生成的获取器。需自定义媒体请求头时，可返回 `fetchMedia: context.mediaFetcher(headers)`。严禁在候选或错误日志中附带个人账号配置；不要输出原始异常、播放地址、密钥或签名。

首版支持明文 MP4、CENC MP4、明文 VOD HLS/DASH 和 MPEG-TS AES-128 HLS。加密 HLS 支持显式 IV、media sequence 默认 IV、key 轮换，包括相同 URI 的新 key；加密 map、加密 byte range、discontinuity、SAMPLE-AES、DRM 和直播会明确拒绝。

媒体签名失效时宿主会重新解析一次，丢弃本次未提交的准备结果；其他错误不会无限重试。浏览器与 Codex 面板继续使用本地媒体路径及会话授权，不直接访问上游 CDN。

## 验证

```sh
npm test
node scripts/verify-providers.mjs --live
```

全量测试包含两内置 Provider 的契约、插件发现/失败/关闭、旧红果兼容、来源隔离、切源竞态和 HLS 解密。`--live` 从临时状态启动编译后的 MCP 服务，验证红果、黄果各一整集的分块传输、音视频解码和历史隔离；不等于 Codex 主窗口实播。
