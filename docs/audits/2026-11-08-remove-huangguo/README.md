# 移除黄果实现，保留 Provider 机制

## 变更范围

- 删除黄果驱动、vendored SDK、专用 SDK 测试、取流验证脚本和打包许可副本。
- 删除黄果专属 ID 分支、界面名称、配色和当前使用说明。
- 保留红果驱动、统一适配契约、内置／本地插件注册与生命周期、启用设置、悬停选源浮层、来源隔离与通用 HLS/DASH/AES/CENC 媒体能力。
- 多源测试改用独立的本地示例 Provider；编译后 MCP 验证从本地目录发现插件，并跨三个服务进程验证启停配置持久化。
- 已移除来源的旧默认设置回退到红果；旧推荐、分屏选择及分集 ID 不会恢复已移除来源。未删除用户的观看记录或个人配置。
- UI 资源更新至 v24，保留旧 URI 读取兼容。旧双源验收材料标为历史快照，不能作为当前支持范围。

## 验证

- `npm test`：179 项，173 通过，0 失败，6 项 Windows 专属测试在 macOS 跳过。删除的是已移除 SDK／站点专项测试，Provider 和通用媒体回归保留。
- `npm run package`：npm 包及离线 ZIP 生成成功。
- 源码及打包文本共扫描 68 个文件，黄果 SDK／站点标记匹配数为 0；两种归档均无已移除 Provider 的文件条目。摘要见 [artifacts.json](artifacts.json)。
- `npm run verify:install -- --playback`：使用临时配置和应用数据检查全新／重复安装、宿主 MCP、红果片库、真实红果媒体准备及分段传输／解码、卸载与数据清理。最终结果见 [installation.json](installation.json)。

测试不更新用户已安装插件。真实媒体验证覆盖 npm 安装副本的 MCP 分段解码，不代表 Codex 主窗口的实际画面、声音或 Windows／Linux 真机验收。
