import { PlayerError } from '../errors.mjs'

export const videoPattern = /^BV[0-9A-Za-z]{10}$/
export const videoCategories = [
  { id: '', name: '推荐' }, { id: 'all', name: '热门' },
  { id: '36', name: '知识' }, { id: '188', name: '科技' }, { id: '4', name: '游戏' },
  { id: '160', name: '生活' }, { id: '211', name: '美食' }, { id: '3', name: '音乐' },
]
const categoryChildren = {
  36: [36, 124, 201, 207, 208, 209, 228, 229, 122, 39],
  188: [188, 95, 230, 231, 232, 233], 4: [4, 17, 171, 172, 65, 173, 121, 136, 19],
  160: [160, 138, 250, 251, 239, 161, 162, 21, 75],
  211: [211, 76, 212, 213, 214, 215], 3: [3, 28, 31, 30, 59, 29, 193, 243, 244],
}
export const videoCategory = tid => Object.entries(categoryChildren).find(([, children]) => children.includes(Number(tid)))?.[0]
export const videoId = value => typeof value === 'string' && value.startsWith('video:') && videoPattern.test(value.slice(6))
export const contentKind = id => String(id).startsWith('video:') ? 'video' : 'bangumi'
export function videoLink(input) {
  let value = String(input).trim(), page = 1
  if (/^https?:\/\//i.test(value)) {
    let url
    try { url = new URL(value) } catch { throw new PlayerError('B 站视频链接无效') }
    if (url.protocol !== 'https:' || !['www.bilibili.com', 'bilibili.com', 'm.bilibili.com'].includes(url.hostname) ||
        url.username || url.password || url.port) throw new PlayerError('请使用 B 站完整视频链接或 BV/AV 编号')
    const match = /^\/video\/(BV[0-9A-Za-z]{10}|av[1-9]\d{0,15})\/?$/.exec(url.pathname)
    if (!match) throw new PlayerError('请使用 B 站完整视频链接或 BV/AV 编号')
    value = match[1]
    if (url.searchParams.has('p')) {
      const p = url.searchParams.getAll('p')
      if (p.length !== 1 || !/^[1-9]\d{0,3}$/.test(p[0])) throw new PlayerError('视频分 P 编号无效')
      page = Number(p[0])
    }
  }
  if (videoPattern.test(value)) return { bvid: value, page }
  if (/^av[1-9]\d{0,15}$/i.test(value) && Number.isSafeInteger(Number(value.slice(2))) && Number(value.slice(2)) < 2 ** 51)
    return { avid: Number(value.slice(2)), page }
  throw new PlayerError('请使用 B 站完整视频链接或 BV/AV 编号')
}
