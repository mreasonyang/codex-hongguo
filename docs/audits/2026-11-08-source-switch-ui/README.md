# 切源入口 UI 验证

将标题栏原生下拉框改为左上角播放图标：两个可用 Provider 时直接切换；更多 Provider 时打开小菜单。当前片源通过图标颜色和标题显示。UI 资源更新为 v21，保留 v20 及之前 URI 的读取兼容。

验证结果：

- `npm test`：191 项，185 通过，6 项 Windows 专属测试在 macOS 跳过，0 失败。
- 新增 UI 行为测试覆盖双源切换、多源菜单选择及默认源保存、单源禁用切换。
- 内置浏览器验证红果 → 黄果 → 红果、多 Provider 菜单选中状态、本地 Provider 选择、方向键导航及 Esc 关闭。
- 检查 397px 浅色／深色面板及 320px 深色面板；320px 下文档宽度为 320px，无横向溢出。

截图使用当前构建的真实播放器 UI、临时独立 Store/Service 和固定测试片库；未读取个人播放记录。此次浏览器验证针对切源界面，不代表 Codex 主窗口实播验收。

- [红果浅色](hongguo-light.png)
- [黄果浅色](huangguo-light.png)
- [多 Provider 菜单](provider-menu.png)
- [黄果深色](huangguo-dark.png)
