// The catalog supplies show names and episode titles. Translate player chrome only.
const en: Record<string, string> = {
  '推荐所属任务已结束，点击播放继续观看': 'The recommended task has ended. Click Play to keep watching.',
  '宿主阻止了自动播放，请点击播放继续': 'The host blocked autoplay. Click Play to continue.',
  设置: 'Settings',
  以下设置对所有聊天生效: 'These settings apply to all chats',
  任务结束自动暂停: 'Pause automatically when a task ends',
  任务开始自动播放: 'Play automatically when a task starts',
  默认静音: 'Mute by default',
  悬停时显示播放器: 'Show player on hover',
  '移出红果面板显示替身并暂停，移回后继续；手动暂停保持不变': 'Leave the player panel to show a cover page and pause. Return to resume; manual pauses are preserved.',
  替身网页: 'Cover page URL',
  留空使用内置工作笔记: 'Leave blank for the built-in work notes',
  '部分网站禁止嵌入；更换网站后需重新打开播放器。清空网址可恢复默认替身。': 'Some sites block embedding. Reopen the player after changing sites. Clear the URL to restore the built-in page.',
  '已保存，重新打开播放器后应用此网址': 'Saved. Reopen the player to use this URL.',
  工作空间: 'Workspace',
  工作笔记: 'Work notes',
  '计划、记录与待办事项': 'Plans, notes and to-dos',
  本周计划: 'This week',
  整理接口文档: 'Organize API documentation',
  核对测试结果: 'Review test results',
  准备迭代评审: 'Prepare the iteration review',
  记录: 'Notes',
  '修改后同步当前播放器；新打开时也沿用此设置': 'Changes apply to the current player and are remembered for new players.',
  '音量暂未保存，请检查本机服务': 'Could not save the volume. Check the local service.',
  '自动播放已选中的剧集，从上次位置继续': 'Play the selected episode from its saved position',
  当前回合进行时显示推荐: 'Suggest shows during a turn',
  推荐补充关键词: 'Additional recommendation keywords',
  用逗号分隔: 'Separate with commas',
  保存设置: 'Save settings',
  正在连接: 'Connecting…',
  回合联动: 'Automatic pausing',
  未关联对话: 'No chat connected',
  '在同窗分屏播放 ↗': 'Open in split view ↗',
  确认会话: 'Choose conversation',
  '在 Codex 内置浏览器打开此链接（60 秒内有效）': 'Open this link in the Codex browser within 60 seconds',
  复制链接: 'Copy link',
  等待时看一集: 'Watch while you wait',
  这条推荐已结束: 'This suggestion has expired.',
  '当前 Codex 无法在会话中打开播放器': 'This version of Codex could not open the player in this chat.',
  收起本轮推荐: 'Hide suggestions for this turn',
  '更多…': 'More…',
  选剧: 'Browse shows',
  搜索剧名: 'Search shows',
  搜索: 'Search',
  观看历史: 'Watch history',
  换一批: 'Next batch',
  继续观看: 'Continue watching',
  看下一集: 'Watch next episode',
  '推荐 · 点击播放': 'Recommended · Play',
  播放器: 'Player',
  '‹ 返回选剧': '‹ Browse shows',
  播放当前集: 'Play this episode',
  短剧视频: 'Drama video',
  播放: 'Play',
  暂停: 'Pause',
  下一集: 'Next episode',
  上一集: 'Previous episode',
  继续播放: 'Resume playback',
  播放进度: 'Playback position',
  播放速度: 'Playback speed',
  静音: 'Mute',
  取消静音: 'Unmute',
  全屏: 'Fullscreen',
  退出全屏: 'Exit fullscreen',
  选择一部短剧: 'Choose a show',
  连播: 'Autoplay next',
  随机一集: 'Pick an episode',
  分集范围: 'Episode groups',
  选集: 'Episodes',
  更多分集: 'Load more episodes',
  '正在读取分集…': 'Loading episodes…',
  暂无可用分集: 'No episodes available',
  取消准备: 'Cancel loading',
  从头播放: 'Start over',
  移除: 'Remove',
  '正在读取片库…': 'Loading shows…',
  没有找到相符的剧目: 'No matching shows',
  红果暂时没有返回推荐剧目: 'Hongguo returned no recommendations.',
  等待回合开始: 'Waiting for a turn',
  当前回合进行中: 'Turn in progress',
  回合已停止: 'Turn stopped',
  回合已中断: 'Turn interrupted',
  '正在准备播放…': 'Preparing playback…',
  正在播放: 'Playing',
  '正在准备首批视频分段…': 'Preparing the first video fragments…',
  '分集续播位置尚未准备好，请重试': 'The saved playback position is not ready. Try again.',
  '分集续播位置准备超时，请重试': 'Preparing the saved playback position timed out. Try again.',
  '本轮已停止，已为你暂停': 'Turn stopped. Playback paused.',
  '本轮已中断，已为你暂停': 'Turn interrupted. Playback paused.',
  已手动暂停: 'Paused',
  本集已播完: 'Episode finished',
  本机状态不可达: 'Local status unavailable',
  '已暂停，点击播放继续': 'Paused. Press Play to resume.',
  '还没有本机回合记录，可先手动观看': 'No local turns yet. Choose a show to watch.',
  '准备超时，请重试': 'Media preparation timed out. Try again.',
  '观看进度暂未写入，请检查本机服务': 'Could not save progress. Check the local service.',
  '该集当前不可播放，请检查片源许可或 FFmpeg 自检结果':
    'This episode is unavailable. Check the source and FFmpeg diagnostics.',
  '上游暂时限制匿名播放，请稍后重试': 'The provider temporarily limited anonymous playback. Try again later.',
  '红果片源暂时不可达，请稍后重试': 'The provider is temporarily unavailable. Try again later.',
  '桌面安全策略阻止了侧栏载入本地视频': 'The desktop security policy blocked the panel from loading local video.',
  '侧栏分段读取失败，请重新点播': 'The panel could not read a video segment. Try playing the episode again.',
  '侧栏无法处理视频分段，可使用同窗分屏': 'The panel could not process a video segment. Open in split view.',
  '等待视频元数据超时，请重新点播': 'Timed out waiting for video metadata. Try playing the episode again.',
  '视频加载已中止，可以重新点播': 'Video loading was interrupted. Try playing the episode again.',
  '读取视频数据失败，请重新点播': 'The player could not read the video data. Try playing the episode again.',
  '播放器解码视频数据失败，可使用同窗分屏': 'The player could not decode the video data. Open in split view.',
  '播放器无法打开视频来源，可重新点播或使用同窗分屏': 'The player could not open the media source. Try again or open in split view.',
  '视频加载失败，请重新点播': 'Video loading failed. Try playing the episode again.',
  '当前面板不支持分段解码，可使用同窗分屏': 'Segmented playback is unavailable here. Open in split view.',
  '已复制，请在 Codex 内置浏览器打开': 'Link copied. Open it in the Codex browser.',
  '链接已选中，请复制并在 Codex 内置浏览器打开': 'Copy the selected link and open it in the Codex browser.',
  '本集播放地址已失效，请重试': 'Playback for this episode expired. Try again.',
  等待会话面板连接: 'Waiting for the conversation panel',
  请求参数无效: 'Invalid settings or request',
  返回选剧: 'Back to shows',
  在同窗分屏播放: 'Open in split view',
  分屏: 'Split view',
  推荐: 'Featured',
  看过: 'Watched',
  重试: 'Retry',
  清除搜索: 'Clear search',
  取消: 'Cancel',
  '正在检查…': 'Checking…',
  进度库: 'Progress store',
  可写: 'Writable',
  不可用: 'Unavailable',
  就绪: 'Ready',
  缺失: 'Missing',
}
let english = false
export function tr(value: string) {
  if (!english) return value
  const trimmed = value.trim(),
    match = en[trimmed]
  if (match) return value.replace(trimmed, match)
  return value
    .replace(/^继续观看 · /, 'Continue watching · ')
    .replace(/^已从 ([\d:]+) 继续$/, 'Resumed at $1')
    .replace(/^移除 (.+) 的观看历史$/, 'Remove $1 from history')
    .replace(/^第 (\d+) 集(?= · |$)/, 'Episode $1')
    .replace(/^(\d+) 集 · /, '$1 episodes · ')
    .replace(/ · 可点击搜索重试$/, ' · Search again to retry')
    .replace(/^(\d+\+?) 集$/, '$1 eps')
}
export function initLocale(locale: string) {
  english = locale.toLowerCase().startsWith('en')
  if (!english) return
  document.documentElement.lang = 'en'
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.tagName === 'SCRIPT') continue
    if (node.nodeValue?.trim()) node.nodeValue = tr(node.nodeValue)
  }
  for (const el of document.querySelectorAll('[aria-label],[placeholder],[title]')) {
    for (const attr of ['aria-label', 'placeholder', 'title']) {
      const value = el.getAttribute(attr)
      if (value) el.setAttribute(attr, tr(value))
    }
  }
}
