# Provider 插件

播放器通过统一适配契约访问 Provider。内置红果、Bilibili 和黄果，本地插件通过同一注册入口加载。首版 API 为 1。

## 黄果（NSFW）

悬停左上角片源图标，选择「黄果 · NSFW」并确认后进入片库，可浏览推荐、搜索剧名、选择分集和续播。每次重新切入都需要确认；取消保持旧片源及播放状态，新聊天从红果开始。注册时不请求黄果站点，切入后才匿名加载；不读取浏览器或其他应用的账号、Cookie 和配置。

黄果 Provider 采用 [Veyra](https://github.com/gybeyond1/Veyra) 的 Node 站点模块，固定上游提交 `a83dfd9a29b23d439da4f853d104568696cd401c`，保留 GPLv3、来源和修改说明。仅引入站点映射与封面解码，网络通过宿主域名白名单、TLS 校验、体积限制、超时和取消处理；不启动 Veyra 服务。许可和修改清单见 `third_party/veyra/NOTICE.md`，发行包对应 `licenses/veyra/`。

浏览使用本站热门榜的有界完成态快照，下一页固定在同一榜单和页大小，不依赖不稳定的全量目录；搜索继续使用原站搜索分页。详情和逐集播放使用匿名 JSON 接口；历史与缓存使用 `p.huangguo.*` 标识，与其他片源隔离。逐集取流适配 2026-11-10 的 `POST /api/videos/<id>/episodes/<n>/playback`，只选择 `streams.main` 或 `streams.hevc`，不回退到 preview。使用本站自身推荐，不发送红果补充关键词。失效播放签名按通用媒体流程重新解析一次。封面在宿主解码，播放地址、请求头和 HLS 密钥留在宿主，不发送到面板。

兼容的 H.264 VOD HLS 按需获取分片，AES-128 分片在宿主解密。需要独立音轨、初始化段等不适用按需路径的清单，会交给整集准备流程。支持范围以通用 HLS 媒体层为准；站点线路或 CDN 变化可能需要更新 Provider 的白名单。此接入不包含账号、会员购买、互动或下载导出界面。

## Bilibili 番剧

内置红果和哔哩哔哩默认可用；悬停左上角图标后点击切换，无需开启设置。首页直接浏览番剧推荐，也可搜索番名、点击结果选择分集。搜索框兼容 `ss2251`、`ep50188` 或 `https://www.bilibili.com/bangumi/play/ss2251`，不必先添加链接。已导入的季度仍保留在本机，正片与预告、花絮分开，进度及缓存与红果隔离。聊天中的推荐、继续观看、回合内固定剧目和可见播放器抑制规则复用红果机制；推荐目录来自 B 站番剧索引，不发送红果的默认补充搜索词。

通过固定的公共 npm SDK `@ikenxuan/amagi@6.6.0` 获取季度、分集和按集播放流，使用 SDK 的公开 Axios adapter 接入宿主有域名、大小、超时及取消限制的请求器。不依赖 Python。SDK 的接口变化由上游跟进，本项目负责 Provider 映射、版本升级及回归。

番名搜索使用 amagi 的 WBI 签名器和受限 HTTP 传输；番剧搜索、公开索引两个 web 操作由本项目的 SDK 边界补齐，不另行实现签名算法。搜索和目录有短期缓存、分页、取消及限流错误处理。暂不提供 `b23.tv` 短链、UGC/BV 投稿或追番同步。默认使用匿名访问；在播放器设置底部「片源账号」分组中点击「哔哩哔哩」紧凑列表行（或在需要登录、仅提供试看的播放提示旁点击「登录片源账号」），即可进入单独的扫码登录子页并使用哔哩哔哩 App 扫码确认，不在设置列表原地展开二维码。二维码约三分钟过期，失败或过期可刷新重试；点击「返回设置」「取消登录」或按 Esc 会取消当前扫码并返回主设置页，关闭设置也会取消当前二维码。确认成功后自动返回主设置页，在账号行显示昵称和会员状态，重启及其他聊天共用本机登录态；再次点击已登录的账号行可进入账号管理并退出登录。退出登录只清除本播放器的登录态，不退出其他浏览器或设备。

登录态单独保存到 Provider 目录的 `account/session.json`，采用原子替换；POSIX 下目录权限为 0700、文件为 0600。不会读取浏览器 Cookie；Cookie 不进入界面、MCP 结果、媒体 CDN、日志或通用进度数据库，扫码链接及票据只在当前登录过程使用，不落盘。只有本人在手机确认后取得的登录态通过 B 站账号接口验证成功，才会保存。会员、地区、购买及 DRM 限制仍以原站和播放器支持能力为准。

已有的 `HONGGUO_BILIBILI_COOKIE` 启动环境配置仍可作为未保存账号时的兼容入口；扫码登录后的本机状态优先。退出后会保存空记录，阻止旧环境配置在重启后自动恢复登录。卸载清理包含此专用账号目录。

只有完整、非 DRM 的普通 MP4 或 AVC/AAC 双轨可以播放。试看即使返回成功状态也明确拒绝。提供 SIDX 的标准双轨走按需播放：宿主读取小型索引，面板及分屏通过本机受限传输获取当前位置附近的片段，MSE 分别追加音视频；首播、深度续播和跳转都不需要先下载整集。CDN 地址、请求头和原始字节范围留在宿主，不进入面板。片段缓存上限 128 MiB，每个片段不超过 32 MiB，备用 CDN 有限重试；无分段索引的单文件等兼容片源沿用原有整集准备路径。两小时以上及预算不合适的流会拒绝。自动下一集、回合暂停、替身移出暂停和返回恢复沿用共享播放器的控制逻辑；分段加载器不发起自动播放，关闭后丢弃晚返回的数据。红果的 MP4 由宿主按字节范围读取，按播放位置生成分片。

登录后使用 amagi 原生账号检查、WBI 签名和大会员选流流程；其内部请求也通过当前 Provider 的受限传输，不再固定走匿名 H5 参数或 480p。播放器从原站授权返回的完整片源中优先选择预算内较高清晰度的 AVC/AAC，超过大小限制时降档；这不代表支持所有 4K、HDR、杜比或 DRM 格式。匿名访问保持原有选流策略。媒体缓存绑定不含凭据的账号版本，登录后重试原先的试看失败与低清晰度缓存，退出或切换账号后不能复用旧账号缓存；准备期间变更账号的结果不会发布。大会员分支已完成模拟账号的真实 SDK、双轨合流及音视频解码自动验证；真实会员专属番剧尚无会员账号实测。

项目采用 AGPL-3.0-only，完整文本见根目录 `LICENSE`。amagi 保留 GPL-3.0-only（`COPYING`）；两种许可证的第 13 条允许组合使用，AGPLv3 的网络交互义务适用于组合程序。历史 MIT 版本的授权继续有效，说明见根目录 `NOTICE`。发行包附带该项目的对应源码 ZIP、固定上游修订的 amagi 原始 TypeScript 源码和校验值；详见包内 `licenses/amagi/NOTICE.txt`。本地源码采用的 npm 依赖和 SDK 版本由锁文件固定，不维护 SDK fork。

## 默认启动与 NSFW 确认

已安装、发现且清单允许启动的 Provider 默认启动，不再提供播放器启用开关或保存 `enabledProviders` 列表。旧版启用列表会迁移清理，其他设置、登录态和观看进度保留。初始选中的片源仍为红果。

清单的 `nsfw` 是布尔值，省略时兼容为 `false`。红果和哔哩哔哩均显式声明 `nsfw: false`。从左上角浮层选择普通片源会直接切换；选择 `nsfw: true` 的片源时显示确认对话框。只有点击「确认切换」才保存源并执行切换；取消、Escape、关闭播放器或替身遮盖会取消本次选择。取消本身不会暂停旧片源或改变进度。每次重新切入 NSFW 源都需要确认，不保存永久豁免。

服务端 `set_source` 对 NSFW 切入要求 `confirmNsfw: true`，未确认请求不改变当前源或媒体授权。新聊天不会自动恢复上次的 NSFW 默认源，也不会从旧推荐自动切入 NSFW 源；需由用户重新选择并确认。普通片源的默认源恢复、首页及聊天推荐逻辑不变。

启动失败只使该插件不可用，不影响其他片源；修复后重新打开连接服务的聊天。`get_providers` 返回 `nsfw`、安装/发现状态、`enabled`、`available` 和固定错误代码。SDK 仍可在首次实际请求时延迟加载。

## 独立开发与安装

用本版插件目录的 `node bin/codex-hongguo.mjs provider --help` 查看命令。已将 npm CLI 加入 PATH 时可直接运行以下示例。开发目录可放在任意工作区。自定义片源需要独立的 ID；`hongguo`、`bilibili` 和 `huangguo` 是内置片源的保留 ID。

```sh
codex-hongguo provider create my-source --template search
codex-hongguo provider test ./my-source
codex-hongguo provider doctor ./my-source --query Sample
codex-hongguo provider preview ./my-source
codex-hongguo provider install ./my-source
codex-hongguo provider list
```

`--template link` 提供按链接导入并持久保存的示例，诊断用公开链接 `https://sample.invalid/watch/sample-one`。两种模板都自带本地目录、分页和有声 MP4。编写独立片源时替换 `index.mjs` 和样例数据传输，保留长期稳定的剧目和分集 ID。用安装包自带的开发 Skill `hongguo-provider` 可以从新目录开始操作。

脚手架的 `sdk/index.mjs`、`sdk/index.d.mts` 和 `sdk/provider.schema.json` 可离线使用。通过 npm 引入时可用 `@kyun.si/codex-hongguo/provider-sdk` 和 `@kyun.si/codex-hongguo/provider.schema.json`。SDK 提供 `page`、`cover`、`filePlayback`、`fetchJSON`、`providerError`、`validateManifest` 与 `validateResult`。外置 Provider 返回原站的不透明字符串游标，宿主处理片源、查询、内容类型和分集的绑定与还原。

| 命令 | 执行内容 |
| --- | --- |
| `test <目录>` | 在临时数据目录中加载和验证契约。开发目录可提供 `provider.fixture.mjs`，导出 `query`、预期无结果的 `missingQuery`、模拟 API 的 `fetch` 或模拟媒体的 `fetchMedia`。宿主请求器默认拒绝联网。检查列表、可用的第二页、详情、封面、分集、预先取消和取流描述，不读取媒体；额外行为见下文。 |
| `doctor <目录> [--query 公开样例]` | 用 `doctor --installed <id>` 检查已安装的副本。使用真实传输、临时数据和 FFmpeg；一次限时 45 秒，API 正文和媒体共用 16 MiB。最多从本次目录、搜索及已检查的第二页选择 3 个真实候选，优先交错搜索和目录样本，失效首条可换下一候选；`samples` 保留每次跳过的阶段/固定码及最终样本来源。鉴权、限流、预算或契约错误不会换样本绕过。目录/搜索/分页的失败仍保留并使 `ok: false`，同时继续能完成的独立媒体检查。`mediaScope` 为 `hls-first-segment`（所选轨首分片）或 `complete`（完整准备所选素材），`decode` 和 `audio` 各验证首秒实际采样。省略 URL 和上游原文。|
| `preview <目录>` | 输出本机预览地址，使用实际分屏播放器与临时数据库。可选集、跳转、切源及检查历史。Ctrl+C 结束。|
| `install <目录>` / `update <目录>` | 复制 `provider.json`、入口文件和 `files` 数组中列出的相对文件。第三方依赖需打入入口或把运行文件列入清单。先对副本执行加载检查，再原子切换活动版本。上游功能修复应先执行 test 和 doctor。 |
| `list` / `rollback <id>` / `remove <id>` | 列出受管理的安装、切回前一份副本或取消注册。更新及移除保留观看历史。旧连接可以继续访问已加载的代码副本，宿主卸载时清理这些文件。 |

在新连接中打开播放器的片源菜单即可选用。在设置的「视频源 → 本地片源状态」可查看本连接加载的版本和最近的请求结果。当前 MCP 进程的 `get_providers` 或 `get_health` 返回实际加载的版本和最近一次目录、分集、解析等操作的阶段状态与时间。缺少观测的阶段代表尚未调用。诊断的 `unverified` 表示跳过或未到达该阶段，`resolve` 通过表示已取得播放描述，`decode` 与 `audio` 记录实际读取到的视频和音频采样。报告以这次检查的时间和版本为准。目录、媒体缓存按安装副本区分。独立开发、预览和安装均不需要改宿主源码。

受管理的副本位于宿主用户数据目录的 `provider-library`。执行环境是可信本地 Node.js 代码，诊断子进程的超时保护和宿主请求预算适用于开发工具，正式安装的 Provider 与 MCP 同进程。

### 接入现成 API 库

用户提供客户端、仓库路径或 npm 包时，从给定版本的公开方法开始。用库现有的目录、搜索、详情和播放方法实现 Provider 的五个接口，保留原站 ID。优先使用库的请求注入点，把 API 请求交给 `context.fetch`，传递方法、正文、请求头和取消信号。检查库期望的返回类型。例如，库约定同步调用 `reply.text()` 时，可先 `const text = await response.text()`，再返回 `{ status: response.status, text: () => text }`。如果库自行发起请求，宿主只能对经其请求器传输的数据实施域名和预算限制。

接入任务保持第三方源码与给定版本一致，验收时核对原始输入与安装副本。镜像选择、返回字段映射、取消归属等兼容处理写在自己的 Provider 或请求注入层，不能修改库或 vendor 副本来取得通过结果。若库自身缺陷无法通过公开接口适配，如实报告限制；不得把本地修补后的依赖冒充原版本。

纯 JS 模块可以用相对路径引入并逐文件列入 `provider.json` 的 `files`。对于 npm 依赖，可在开发项目中用已有的打包器生成 Node.js ESM 入口。例如，项目已锁定 esbuild 时，运行 `npx --no-install esbuild index.mjs --bundle --platform=node --format=esm --outfile=dist/provider.mjs`，并将清单的 `entry` 指向 `dist/provider.mjs`。检查动态加载的资源、配套解码器、原生模块和库要求随附的许可文件。脚手架的 `sdk/` 源码来自本项目的 AGPL-3.0-only 代码；`create` 已自动附上 `sdk/LICENSE` 与来源 `sdk/NOTICE` 并列入 `files`，交付时保留，不能只附第三方 API 库的许可证。安装器只复制清单声明的文件，依赖安装与构建在开发端完成。

从库、上游文档或配套应用的媒体域配置确定允许的 CDN 范围。分别填写 `network.api` 和 `network.media`。对于 HLS，媒体请求可能从主清单跳到变体、独立音轨、初始化段、分片或密钥所在的其他主机。`*.example.org` 只匹配子域，根域需单独列出。需要 Referer 等请求头时，让 `resolvePlayback` 返回 `fetchMedia: context.mediaFetcher(...)`，并把请求头限制在需要它们的目标域。

### 安装副本隔离验收

先在临时数据目录里安装，再验证独立运行。以下 POSIX 示例只改名自己创建的开发副本；源目录必须是可移动的新副本，不能指向用户已有仓库、共享依赖或正式安装。若有外部库开发目录，也应先复制到临时工作区并在诊断期间移走。Windows 可用同一 PowerShell 会话的临时 `$env:HONGGUO_DATA_DIR`、`Move-Item` 与 `try/finally` 执行相同步骤。

```sh
(
  export HONGGUO_DATA_DIR="$(mktemp -d)"
  source_dir="$PWD/my-source"
  withheld_dir="${source_dir}.withheld"
  test ! -e "$withheld_dir" || exit 1
  codex-hongguo provider install "$source_dir" || exit 1
  mv "$source_dir" "$withheld_dir" || exit 1
  trap 'mv "$withheld_dir" "$source_dir"' EXIT
  codex-hongguo provider doctor --installed my-source --query '公开样例'
)
```

`doctor` 是安装完成后启动的新 CLI 进程，不复用开发时已加载的模块。核对安装版本与入口、`files` 中的资源及许可；原样保留上游通知时，另说明独立包内对应路径和实际提供的源码，避免沿用不成立的宿主 ZIP 路径。开发 fixture 默认不会被复制，除非列入 `files`；未带 fixture 的安装目录直接运行离线 `test` 可能在目录阶段失败，应使用开发副本做离线契约测试、安装副本做真实 `doctor`，分别报告。

开发目录可用、安装时却报 `LOAD_FAILED`，先检查入口和随包运行文件。媒体阶段报 `HOST_NOT_ALLOWED`，核对清单及每次跳转所需的域名；报 `BUDGET` 则检查首分片、独立音轨及其他响应的合计大小。域名会轮换时，换一集或重新解析后复查。以 `decode: passed` 及有声素材的 `audio: passed` 确认安装副本可解码；整集播放、拖动和续播仍由播放器预览验证。

### 取消与并发调用

每个操作都合并 `context.signal` 和单次 `signal`，并传到底层请求。宿主拦截已取消调用、丢弃晚到结果，不能证明网络已停止。SDK 的共享探活、登录刷新或缓存 Promise 若使用首个调用的 signal，取消该调用可能使其他未取消调用一起失败；仅用 AsyncLocalStorage 或替换当前 signal 不能消除这类共享状态。

优先使用库原生的单请求取消与共享操作订阅机制。库没有这种能力时，可让并发操作各自使用独立 client；需要复用时，只复用已经空闲的 client。不要为解决串扰而吞掉取消、去掉 signal，或对鉴权与限流失败盲目重试。以下是同步 `reply.text()` 接口的逐操作 client 示例，具体状态码与返回类型仍按库契约适配：

```js
async function withClient(context, signal, operation) {
  const active = signal ? AbortSignal.any([context.signal, signal]) : context.signal
  if (active.aborted) throw providerError('ABORTED')
  const client = createClient({ request: async (url, options = {}) => {
    const requestSignal = options.signal ? AbortSignal.any([active, options.signal]) : active
    const response = await context.fetch(url, { ...options, signal: requestSignal })
    const text = await response.text()
    return { status: response.status, text: () => text }
  } })
  try {
    return await operation(client)
  } catch (error) {
    if (active.aborted) throw providerError('ABORTED')
    throw error // 在适配器边界映射固定错误码，不记录上游原文
  } finally {
    await client.dispose?.()
  }
}
```

取封面时也要转发信号并消费 `fetchMedia` 返回的限量流。例如在已合并的 `signal` 下读取小图：

```js
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

async function coverBytes(context, url, signal) {
  const { body, limit } = await context.fetchMedia(url, 2 << 20, 10000, undefined, undefined, signal)
  const chunks = []
  await pipeline(Readable.from(body), limit, async source => {
    for await (const chunk of source) chunks.push(Buffer.from(chunk))
  }, { signal })
  return Buffer.concat(chunks)
}
```

### 稳定身份与分页

每个原站视频可以映射成一部单集剧目；原站确实只有一集时，分集第二页不适用，不虚构多集来让检查变绿。剧目、分集和默认分集 ID 都须满足 96 UTF-8 字节限制，复合分集 ID 也要计入分隔符和集号。

原站 ID 太长时，可用确定性 SHA-256 别名，并在 `context.dataDir` 原子持久保存完整原站 ID 与所属剧目的对应关系。别名应使用独立前缀和一致的编码规则，检查原站短 ID 与别名的冲突，不可截断原站 ID、按列表顺序编号或跳过超长条目。列表、详情、链接导入和分集必须使用同一映射；重启后的新实例应只凭历史 ID 就能查询与解析，无需先浏览目录。映射缺失或不匹配时返回固定 `NOT_FOUND` 等安全错误，不能指向其他内容。只保存身份映射，不保存临时播放签名或凭据。

按原站语义透传页码或不透明游标，fixture 同样应尊重请求的页大小。原站给出 next URL 时校验域名、路径和查询绑定；已确认是同一官方接口的 HTTP next URL 可以仅在请求时升级到 HTTPS，保留游标语义，不放宽白名单或重写页偏移。验证至少两页无重复、无跳页；还要覆盖一组小页大小及结束页。宿主 `test` 的第二页检查仅拒绝重复 ID 和不变游标，不能代替这些语义检查。

### 补充行为验证

为适配器或库的实际传输注入点写小型验证脚本，用可释放的阻塞 mock 请求验证下列行为。直接调用 `createProvider(context)`，避免把宿主注册表的取消拦截误算成适配器能力。mock 返回库真实入口所需的响应结构，不绕过库直接返回最终 Provider 结果。

- 请求已进入 transport 后再取消单次 signal，断言底层请求收到中止、操作及时结束且无悬挂；对列表与取流各做一次。换成 `context.signal` 中止再检查这两条路径。
- 同一实例首次并发发起 A、B 两个独立操作。等两者都进入底层后只取消 A；B 应保持可继续，在释放它自己的 mock 响应后成功完成，B signal 未中止。只证明 B 未被取消还不够，必须证明它完成了。
- 新实例在同一个 `dataDir` 中只凭保存的分集 ID 解析；涉及超长 ID 时也验证别名恢复、链接导入一致和映射缺失的固定错误。

脚本的有界超时只用于发现悬挂，不依靠任意等待时长决定并发顺序。根据实际站点补必要的分页、缺失内容和错误码检查。无需为无网络的本地模板伪造 SDK 并发场景；不适用项说明原因。验证脚本和结果作为交付证据，不把它们声称为现有 CLI 已自动执行的检查。

### 验收结果范围

| 证据 | 能证明什么 | 仍需区分 |
| --- | --- | --- |
| 离线 `test` 与补充脚本 | 模拟响应下的契约、分页或取消行为 | 不证明真实 API、域白名单或媒体；本地模板全绿也不代表接入了站点 |
| 真实 API 请求 | 本次查询、详情、分集与实际调用计数 | 用公开 query；没有搜索的空 query 不算搜索通过 |
| 源目录缺席的安装副本 `doctor` | 该版本独立运行、所选样本媒体准备和首秒音视频解码 | `hls-first-segment` 仅所选轨首分片；`complete` 是完整准备该素材，非整集观看或全片库覆盖；无音轨时保留 audio unverified |
| 播放器观察 | 实际观察过的选集、播放推进、跳转及续播 | 启动 preview 不等于实播；页面刷新续播与宿主进程重启续播分开，未听音不声称听感通过 |

报告列明版本、样例或数量、每层证据路径、已修复失败及未验收项。`catalog`、`search` 和成功检查的第二页记录 `itemCount`；声明支持发现的非链接片源若默认目录为空，真实 `doctor` 把目录记为失败，而不是仅凭请求成功判定首页可用。仅支持搜索的源应显式声明 `discovery: false`。媒体域轮换或上游暂不可达时记录固定阶段码和本次范围；不以样例替代真源、不提高预算掩盖失败，也不因单次采样成功声称所有剧集和 CDN 已验收。

真实请求失败时，继续定位到实际目标接口：检查 SDK 是否先依赖另一业务接口探活、错误是否在包装时丢失。HTTP 200 配合业务 `status=0` 不等于网络不可达；在内存中提取必要的固定业务码或简短无凭据原因，避免保存原始响应、标题和上游任意异常。仅对已确认的临时读取错误有界切换镜像，不能把所有业务拒绝都重试，也不能盲重发播放 POST。用少量对照请求区分目录、搜索、详情和取流，不能因目录失败就判定整个站点不可用。选择可用的原站热门榜作为浏览入口时，明确实际来源、分页范围与原目录仍失败的事实；已发游标不能中途切换数据集。

## 手工加载本地目录

开发时也可以在启动 MCP 服务的环境中设置 `HONGGUO_PROVIDERS_DIR` 为插件父目录。目录本身及插件入口不能是符号链接；插件只在服务启动时发现，增删后重新打开连接该服务的聊天。

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

`id` 使用小写字母开头的字母、数字、连字符，最长 32 字符；内置 `hongguo`、`bilibili`、`huangguo` 不允许被覆盖。`entry` 必须是插件目录内的 `.mjs` 文件。清单的 `enabled: false` 仍可由插件维护者禁止加载该入口；移除此清单限制并重启服务后即默认启动，没有播放器启用开关。

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
      // 使用原站 ID 和原生游标；宿主会把游标绑定片源、操作和查询。
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
- `fetchMedia(url, budget, timeout, redirects, range, signal?)`：按媒体白名单获取，返回 `{body, limit, url}`；`body` 为异步字节流，消费时须经过 `limit` Transform，媒体处理器会计入预算。末尾可传单次取消信号。
- `mediaFetcher(headers)`：创建带固定请求头或 `targetURL => headers` 回调的媒体获取函数，用于 Referer / User-Agent 等片源要求。

宿主会限制清单和导入路径、发现数量，以及导入和工厂耗时。异步工厂出错、缺少方法或版本不支持时，该插件不出现在可选片源中；`get_providers` 可查看固定错误代码。一个插件不能覆盖已注册插件。

Provider 请求有宿主超时与结果失效保护。插件应主动响应 signal；宿主丢弃晚到结果不等于第三方 SDK 的底层网络已取消。

清单可选声明 `queryMode: "link"`、`queryHint` 和 `emptyMessage`（提示文字各不超过 160 字符）。链接模式只在点击添加或回车后提交，输入过程中不触发搜索。清单可显式指定 `discovery`、`recommendationTerms` 与 `progressivePlayback`。启用 `progressivePlayback` 后，带分段索引的双轨媒体和兼容的 H.264 VOD HLS 可按需播放。清单声明优先，已有适配器对象上的同名能力继续生效。外置片源的默认推荐只读取其目录。有补充搜索需求时显式返回 `recommendationTerms`。返回的 Provider 可声明 `discovery: false`，由其 `listSeries()` 提供自己的已添加列表；宿主不会用红果推荐关键词补充该列表。

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
node scripts/verify-huangguo.mjs --live --playback
```

全量测试包含内置红果契约、本地示例插件默认启动/失败/重启、NSFW 元数据与确认/取消、旧设置迁移、来源隔离、切源竞态和通用 HLS 解密。`verify:install -- --playback` 在隔离安装中验证红果片库与媒体链路；不等于 Codex 主窗口实播。

`verify-huangguo --live` 在隔离临时数据目录中通过编译后的 MCP 检查黄果确认、目录、搜索、封面和分集；加 `--playback` 会获取一集、传输全部面板分块并解码音视频，随后删除媒体及状态。可用 `--report <路径>` 保存只含数量、结果和构建摘要的回执；不会保存标题、上游地址、签名或密钥，也不会修改已安装插件。
