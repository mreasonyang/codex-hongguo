# 视频源适配层可行性验证

> 历史快照：黄果驱动、vendored SDK 与专用验证脚本已移除。本目录保留先前记录，不能代表当前支持范围，也不作为当前复现步骤；当前契约见 [Provider 插件](../../providers.md)。

日期：2026-11-08（Asia/Shanghai）。项目基线 `5033523ca1a39bfb01ac3ad447fe788aa4db99a4` / 0.0.34。

范围：方案、临时原型与小规模真实取流；未修改 `src/`、产品测试、依赖、安装配置或版本号。方案见 [video-source-adapters.md](../../design/video-source-adapters.md)。

这是实施前的历史记录，`probe.mjs` 中“当前边界阻断”及旧 HLS 拒绝检查仅针对上面的基线提交。新实现已经移除这些阻断，当前分支应使用 [实施验收](../2026-11-08-provider-implementation/README.md) 中的全量测试和 `scripts/verify-providers.mjs`，不能把此旧探针直接作为新实现的回归测试。

## 结果

| 验证 | 结果 | 证据范围 |
| --- | --- | --- |
| 上游 SDK 离线测试 | 18/18 通过 | 封面解密、清单解析、ID、请求与重试等；profile 指向临时目录 |
| 隔离探针 | 12/12 通过 | 见 [receipt.json](receipt.json)；含线上检查与已知阻断点的反向验证 |
| 现有媒体定向回归 | 9/9 通过 | CENC、HLS/DASH、MCP 授权与块大小、渐进分片、预取、转码回退、CDN 校验 |
| 真实 API | 成功 | 匿名列表取 2 条；返回 total=3292；选定详情有 21 集；搜索返回 2 条 |
| 真实封面 | 成功 | 解密得到 JPEG，174813 字节；未保留图片 |
| 真实媒体短样本 | 成功 | 首 2 分片；解密后 3601140 字节；重封装、现有 PanelMedia 分块再解码成功 |
| PanelMedia 样本 | 成功 | 3 个媒体资产、20 次分块读取，时长元数据 11090ms |
| 完整新片源 Service/MCP 接入 | 尚未实施 | 当前 schema 仍拒绝 hghub 与 hh ID |
| 整集/桌面/跨平台播放 | 尚未验证 | `desktopPlaybackObserved=false`，未观察主窗口画面或声音 |

最终一次探针的真实请求共 10 次、3800383 字节；本轮完成了两次完整探针，共 20 次真实请求。所有媒体、清单、密钥与临时 SQLite 均仅在隔离目录/内存中使用，探针结束清理临时数据。持久回执只保留计数、布尔值、时长和错误代码。`receipt.json` 绑定探针 SHA-256；三组测试汇总见 [validation.json](validation.json)。

## 探针说明

历史探针（脚本已移除） 是实验脚本，不注册适配器、不改产品状态，也不安装插件。它验证：

1. 上游 SDK Git blob 与固定版本一致。
2. 当前来源 schema、ID schema、CDN 域名限制和历史总列表确实阻断黄果；这些检查“通过”表示确认了现状问题，不表示产品已支持黄果。
3. 一个游标/复合集 ID 草案可以往返并拒绝跨来源、跨查询复用；未实现完整适配器分页。
4. 生成合成 HLS 样本，分别验证显式 IV、默认 sequence IV 和不同 URI 的 key 轮换；现有 adaptive 处理器按预期拒绝，新实验处理器可解密重封装。
5. 对合成及真实样本直接调用现有 PanelMedia 的 prepare/manifest/chunk，并拼装数据交给 FFmpeg 解码。没有通过 Service 扩展后的 schema，也没有运行前端 Hls 实例或观察桌面。
6. `--live` 时做有上限的匿名请求，获取一部剧的两个分片，不批量下载。

实验 HLS 处理器只支持 MPEG-TS，无 map、byterange 或 discontinuity。它不能当作已经完备的生产 HLS 实现。KEY 同 URI 更新、KEYFORMAT 变体、签名过期和错误重试未验证。

脚本显式提供无持久化 profile store，禁止请求带 Cookie/Authorization。SDK 的 `store: null` 不可靠，因为构造函数会回退默认文件存储。上游测试未修改，其默认 profile 目录通过 `HGHUB_CONFIG_DIR` 隔离。

## 复现

本机已有项目依赖和插件管理的 FFmpeg，运行环境为 Node v26.11.0 / macOS ARM64。未覆盖项目最低 Node 版本或其他平台。

```sh
# 默认只跑离线探针；SDK 从固定 GitHub 提交取得，并验证 Git blob。
node docs/audits/2026-11-08-source-adapters/probe.mjs

# 增加有限真实请求，覆盖 receipt.json。
node docs/audits/2026-11-08-source-adapters/probe.mjs --live

# 若已通过 GitHub 工具取得该版本 SDK，可指定其本地副本。
node docs/audits/2026-11-08-source-adapters/probe.mjs --sdk /path/to/hghub/index.js --live

# 本轮实际运行的既有定向回归。
node --test --test-timeout=180000 \
  --test-name-pattern='CENC sample|MCP full episode|first fragment|next-episode preload|speculative preparation|provider HEVC|hls|dash|CDN checks' \
  test/core.test.mjs
```

上游离线测试：从固定提交读取 `sdk/hghub/index.js`、`sdk/hghub/test/hghub.test.js`，保持目录结构和 ESM package，在临时目录执行：

```sh
HGHUB_CONFIG_DIR=/path/to/temp/isolated-profile node --test /path/to/temp/sdk/test/hghub.test.js
```

固定上游：[0013315087149b1f717e6a260524de0dce0d1485](https://github.com/frostming/dsh-hongguo/tree/0013315087149b1f717e6a260524de0dce0d1485)。SDK Git blob：`4a649383a55a7cb14abee3b4b7389a895cf70c58`。

探针自身对失败只输出阶段和固定格式错误代码；输出不包含媒体 URL、密钥、能力值、原始站点响应或异常堆栈。总计通过与失败数量不能替代逐项检查，真实线路失败会单独记录。
