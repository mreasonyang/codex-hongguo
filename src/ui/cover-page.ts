// Local presentation only: no network, saved preferences or playback state.
const zh = {
  workspace: '工作空间', projects: ['工作台迭代', '接口整合', '数据质量改进', '服务可观测性'],
  navigation: ['概览', '项目待办', '技术文档', '测试报告', '会议纪要'],
  titles: ['项目待办', '技术文档', '测试报告', '会议纪要'],
  subtitles: ['梳理当前迭代的事项与交付进度', '实现约定、处理流程与验收说明', '当前迭代的回归结果与问题跟踪', '议题记录、讨论结论与后续行动'],
  updated: '更新于', iteration: '当前迭代', groups: ['待处理', '进行中', '已完成'],
  taskNames: ['整理接口文档', '补充边界用例', '核对字段映射', '更新部署说明', '完善错误提示', '梳理依赖关系', '复核响应时间', '整理评审意见', '校验空列表状态', '补充监控指标', '检查分页逻辑', '同步验收清单'],
  taskNotes: ['与验收清单保持一致', '在下次同步前完成确认', '记录结论并补充到文档', '完成后安排交叉复核'],
  tags: ['文档', '开发', '测试', '评审'], items: '事项', progress: '进度',
  contents: '目录',
  sectionTitles: ['背景与目标', '处理流程', '数据约定', '异常处理', '验收要点'],
  paragraphs: [
    '统一现有处理流程，明确输入、输出与状态边界，减少重复确认和隐式依赖。',
    '先校验输入，再执行处理并记录结果。重复操作应保持结果一致，避免重复提交。',
    '字段命名与接口定义保持一致。缺失字段和空值分别处理，分页结果保留稳定顺序。',
    '失败时保留可恢复的上下文，并提供明确的处理提示。重试应有次数和时间限制。',
    '覆盖正常路径、空数据、边界输入与重复操作，验收结果记录在本轮检查清单中。',
  ],
  note: '本轮调整先完成接口约定，再同步实现与验证结果。', configuration: '配置示例',
  total: '执行用例', passed: '通过', failed: '待修复', blocked: '待确认',
  scenarios: ['正常请求', '空列表返回', '分页边界', '重复提交', '超时处理', '字段校验', '状态恢复', '批量更新', '结果排序'],
  tableHeaders: ['检查项', '结果', '耗时'], reportNote: '统计口径：当前迭代回归集',
  participants: '参与角色', roles: ['产品', '开发', '测试'],
  conclusions: ['确认按当前范围推进，细节补充到实现说明。', '边界情况纳入本轮回归，结果在下次同步时复核。', '先完成依赖项确认，再安排联调与验收。', '对齐交付顺序，未决项由对应负责人继续跟进。'],
  actions: '行动项', owner: '负责人', timing: '本周跟进',
}
const en: typeof zh = {
  workspace: 'Workspace', projects: ['Workspace iteration', 'API integration', 'Data quality', 'Service observability'],
  navigation: ['Overview', 'Project tasks', 'Technical notes', 'Test report', 'Meeting notes'],
  titles: ['Project tasks', 'Technical notes', 'Test report', 'Meeting notes'],
  subtitles: ['Current work and delivery progress', 'Implementation contracts, flows and acceptance criteria', 'Regression results and issue tracking for this iteration', 'Topics, decisions and follow-up actions'],
  updated: 'Updated', iteration: 'Current iteration', groups: ['To do', 'In progress', 'Done'],
  taskNames: ['Organize API documentation', 'Add boundary test cases', 'Review field mappings', 'Update deployment notes', 'Improve error messages', 'Review dependencies', 'Check response times', 'Consolidate review feedback', 'Check empty states', 'Add monitoring metrics', 'Review pagination', 'Update acceptance checklist'],
  taskNotes: ['Keep aligned with the acceptance checklist', 'Confirm before the next sync', 'Record the decision in the documentation', 'Arrange a cross-check after completion'],
  tags: ['Documentation', 'Development', 'Testing', 'Review'], items: 'Items', progress: 'Progress',
  contents: 'Contents',
  sectionTitles: ['Background and goals', 'Processing flow', 'Data contracts', 'Error handling', 'Acceptance criteria'],
  paragraphs: [
    'Align the processing flow and define input, output and state boundaries to reduce repeated checks and implicit dependencies.',
    'Validate input before processing and record the result. Repeated operations should remain consistent and avoid duplicate submissions.',
    'Keep field names aligned with the interface definition. Handle missing fields and null values separately, and preserve a stable page order.',
    'Keep recoverable context on failure and provide clear recovery steps. Retries should have bounded attempts and time limits.',
    'Cover normal paths, empty data, boundary inputs and repeated operations. Record the results in the iteration checklist.',
  ],
  note: 'Agree on the interface contract first, then align implementation and verification results.', configuration: 'Configuration example',
  total: 'Test cases', passed: 'Passed', failed: 'To fix', blocked: 'To review',
  scenarios: ['Normal request', 'Empty list', 'Page boundaries', 'Duplicate submission', 'Timeout handling', 'Field validation', 'State recovery', 'Batch update', 'Result ordering'],
  tableHeaders: ['Check', 'Result', 'Duration'], reportNote: 'Scope: the current iteration regression suite',
  participants: 'Participants', roles: ['Product', 'Development', 'Testing'],
  conclusions: ['Proceed with the agreed scope and add details to the implementation notes.', 'Include boundary cases in regression testing and review the results at the next sync.', 'Confirm dependencies before integration and acceptance testing.', 'Align delivery order and assign owners to follow up on open items.'],
  actions: 'Action items', owner: 'Owner', timing: 'Follow up this week',
}
const kinds = ['tasks', 'document', 'report', 'minutes'] as const
type Kind = typeof kinds[number]

/** One page per mounted player. Only an explicit settings action replaces it. */
export function createCoverPage(host: HTMLElement, random: () => number = Math.random) {
  const doc = host.ownerDocument
  let copy = zh, language = 'zh-CN', current: Kind | undefined
  const number = (min: number, max: number) => min + Math.floor(random() * (max - min + 1))
  const choose = <T,>(items: readonly T[]): T => items[number(0, items.length - 1)]
  function sample<T>(items: readonly T[], count: number) {
    const rest = [...items], result: T[] = []
    while (rest.length && result.length < count) result.push(rest.splice(number(0, rest.length - 1), 1)[0])
    return result
  }
  function node<K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text?: string) {
    const element = doc.createElement(tag)
    element.className = className
    if (text !== undefined) element.textContent = text
    return element
  }
  const badge = (text: string) => node('span', 'coverBadge', text)
  function heading(title: string) { return node('h2', '', title) }
  function tasks(body: HTMLElement, frame: HTMLElement) {
    const columns = choose([2, 3]), names = sample(copy.taskNames, number(7, 10))
    const labels = columns === 2 ? [copy.groups[0], copy.groups[2]] : copy.groups
    const board = node('div', 'coverBoard')
    frame.style.setProperty('--cover-columns', String(columns))
    labels.forEach((label, group) => {
      const lane = node('section', 'coverLane'), items = names.filter((_, i) => i % columns === group)
      const title = node('div', 'coverLaneTitle')
      title.append(heading(label), badge(String(items.length)))
      lane.append(title)
      items.forEach(name => {
        const card = node('article', 'coverTask')
        card.append(badge(choose(copy.tags)), node('h3', '', name), node('p', '', choose(copy.taskNotes)))
        lane.append(card)
      })
      board.append(lane)
    })
    const summary = node('div', 'coverSummary')
    summary.append(node('span', '', `${copy.items} · ${names.length}`), node('span', '', `${copy.progress} · ${Math.floor(100 * names.filter((_, i) => i % columns === columns - 1).length / names.length)}%`))
    body.append(summary, board)
  }
  function documentPage(body: HTMLElement) {
    const grid = node('div', 'coverArticleGrid'), article = node('article', 'coverArticle')
    const sections = sample([1, 2, 3], number(1, 3)).sort()
    sections.unshift(0); sections.push(4)
    const contents = node('aside', 'coverContents')
    contents.append(heading(copy.contents))
    sections.forEach((index, position) => {
      const section = node('section')
      section.append(heading(`${position + 1}. ${copy.sectionTitles[index]}`), node('p', '', copy.paragraphs[index]))
      if (position === 0) section.append(node('blockquote', 'coverCallout', copy.note))
      if (index === 2) {
        const pre = node('pre')
        pre.append(node('code', '', choose([
          '{\n  "pageSize": 20,\n  "timeoutMs": 3000,\n  "retryLimit": 2\n}',
          'type Result<T> = {\n  items: T[]\n  nextPage?: string\n  total: number\n}',
        ])))
        section.append(node('h3', '', copy.configuration), pre)
      }
      article.append(section)
      contents.append(node('p', '', copy.sectionTitles[index]))
    })
    grid.append(article)
    if (random() < 0.6) grid.append(contents)
    body.append(grid)
  }
  function report(body: HTMLElement) {
    const total = choose([84, 96, 108, 120, 132]), failed = number(0, 4), blocked = number(0, 2)
    const metrics = node('dl', 'coverMetrics')
    ;[[copy.total, total], [copy.passed, total - failed - blocked], [copy.failed, failed], [copy.blocked, blocked]].forEach(([label, value]) => {
      const metric = node('div')
      metric.append(node('dt', '', String(label)), node('dd', '', String(value)))
      metrics.append(metric)
    })
    const wrap = node('div', 'coverTableWrap'), table = node('table', 'coverTable'), head = node('thead'), header = node('tr')
    copy.tableHeaders.forEach(label => { const cell = node('th', '', label); cell.scope = 'col'; header.append(cell) })
    head.append(header)
    const rows = node('tbody')
    sample(copy.scenarios, number(5, 9)).forEach((scenario, index) => {
      const row = node('tr'), result = index < failed ? copy.failed : index < failed + blocked ? copy.blocked : copy.passed
      const status = node('td'); status.append(badge(result))
      row.append(node('td', '', scenario), status, node('td', 'coverNumber', `${number(12, 480)} ms`))
      rows.append(row)
    })
    table.append(head, rows); wrap.append(table)
    body.append(metrics, wrap, node('p', 'coverFootnote', copy.reportNote))
  }
  function minutes(body: HTMLElement) {
    const intro = node('div', 'coverMeetingMeta')
    intro.append(node('span', '', copy.participants), node('strong', '', copy.roles.join(' · ')))
    body.append(intro)
    const topics = sample(copy.taskNames, number(2, 4))
    const conclusions = sample(copy.conclusions, topics.length)
    topics.forEach((topic, index) => {
      const section = node('section', 'coverTopic')
      section.append(heading(`${String(index + 1).padStart(2, '0')} / ${topic}`), node('p', '', conclusions[index]))
      body.append(section)
    })
    const section = node('section', 'coverActions'), list = node('ul')
    section.append(heading(copy.actions))
    sample(copy.taskNames, number(3, 5)).forEach((task, index) => {
      const item = node('li'), detail = node('div')
      detail.append(node('strong', '', task), node('p', '', `${copy.owner} · ${copy.roles[index % copy.roles.length]}`))
      item.append(node('span', 'coverCheck', '□'), detail, badge(copy.timing))
      list.append(item)
    })
    section.append(list); body.append(section)
  }
  function render() {
    current = choose(kinds.filter(kind => kind !== current))
    const index = kinds.indexOf(current), project = choose(copy.projects)
    const frame = node('div', 'coverPage')
    frame.dataset.template = current
    frame.dataset.density = choose(['comfortable', 'compact'])
    frame.lang = language
    frame.style.setProperty('--cover-width', choose(['900px', '1040px', '1160px']))
    const top = node('div', 'coverTopbar')
    top.append(node('strong', '', copy.workspace), node('span', '', project))
    const layout = node('div', 'coverLayout')
    if (random() < 0.6) {
      layout.classList.add('withSidebar')
      const sidebar = node('aside', 'coverSidebar')
      sidebar.append(node('p', '', copy.iteration))
      copy.navigation.forEach((label, position) => {
        const item = node('div', position === index + 1 ? 'selected' : '', label)
        sidebar.append(item)
      })
      layout.append(sidebar)
    }
    const body = node('div', 'coverBody'), header = node('header', 'coverHeader')
    const date = new Date().toLocaleDateString(language, { month: 'short', day: 'numeric' })
    header.append(node('p', 'coverEyebrow', `${project} / ${copy.iteration}`), node('h1', '', copy.titles[index]),
      node('p', 'coverSubtitle', copy.subtitles[index]), node('p', 'coverDate', `${copy.updated} ${date}`))
    body.append(header)
    if (current === 'tasks') tasks(body, frame)
    else if (current === 'document') documentPage(body)
    else if (current === 'report') report(body)
    else minutes(body)
    layout.append(body); frame.append(top, layout)
    host.setAttribute('aria-label', copy.titles[index])
    host.replaceChildren(frame)
    host.scrollTop = 0
  }
  return {
    initialize(locale: string) {
      if (current) return
      language = locale.toLowerCase().startsWith('en') ? 'en' : 'zh-CN'
      copy = language === 'en' ? en : zh
      render()
    },
    change() { if (current) render() },
  }
}
