/*! Vendored from frostming/dsh-hongguo 0013315087149b1f717e6a260524de0dce0d1485; MIT, Copyright (c) 2026 Frost Ming. See third_party/hghub/LICENSE. Local change: injected bounded fetch. */
/**
 * hghub — 黄果短剧站的非官方 API 客户端。
 *
 * 数据获取方法参考 Minireel/HGhub（Rust + Tauri）：上游把全部 `/api/**` 调用
 * 收敛成**一个**边缘信封接口，客户端不需要关心 Cookie、签名或加密响应：
 *
 *   POST {base}/api/edge/request
 *   {
 *     method: "GET" | "POST" | ...,
 *     path:   "/api/videos?page=1&size=20",
 *     body:   base64(JSON) | "",
 *     content_type: "application/json" | ""
 *   }
 *   Authorization: Bearer <token>   // 只有登录后的互动接口需要
 *
 * 响应信封 `{ status, msg, data }`：`status === 1` 时 `data` 是业务数据。
 *
 * 浏览目录、搜索、取播放地址都**不需要登录**，所以本客户端默认匿名运行；
 * 只有点赞/收藏/评论这类互动接口才需要 `login()`。
 *
 * 另有三处上游特有的细节，本文件在 Node 侧一并处理：
 *   1. 线路（域名）经常变：固定线路 + 地址发布页上的镜像线路。
 *   2. 封面是 AES-128-CBC 密文（`f5d965df75336270` / `97b60394abc2fbe1`）。
 *   3. 播放是标准 HLS + AES-128，m3u8 里的分片与 key 是 CDN 绝对地址。
 *
 * 仅用于个人学习与研究。内容版权归权利人所有，请勿批量抓取或再分发。
 */

import { createDecipheriv, createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

/* ───────────────────────── 常量 ───────────────────────── */

/** 固定线路；不依赖任何外部页面。 */
export const HGHUB_LINES = [
  { name: '固定线路 1', url: 'https://huangguoai.com' },
  { name: '固定线路 2', url: 'https://huangguoai.ai' },
]
/** 旧名，保留给已经引用的地方。 */
export const FIXED_LINES = HGHUB_LINES

/** 地址发布页：页面本身是空壳，真正的清单在 `publish.js` 里。 */
export const PUBLISH_PAGE = 'https://huangguoai.pages.dev/'

/** 封面相对路径的基址（`/upload_01/...` 这类）。 */
export const IMAGE_BASE = 'https://pic.drleao.cn'

/** 封面 AES-128-CBC 的密钥与 IV（APK / 前端共用同一对常量）。 */
const IMAGE_KEY = Buffer.from('f5d965df75336270', 'utf8')
const IMAGE_IV = Buffer.from('97b60394abc2fbe1', 'utf8')

/** 站点把非浏览器的缺省 UA 挡在门外，浏览器 UA 最稳。 */
export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 目录页（`/api/videos/category/{cate}`）接受的频道。 */
export const CATEGORIES = [
  { cate: 'ai-duanju', name: 'AI 短剧' },
  { cate: 'ai-manju', name: 'AI 漫剧' },
  { cate: 'ai-huanlian', name: 'AI 换脸' },
  { cate: 'ai-mogai', name: 'AI 魔改' },
]

/** 榜种。 */
export const RANKS = ['hot', 'recommend', 'potential']

/**
 * 播放链路里可能出现的主机后缀。CDN 域名按 `tp1..tp8.drleao.cn` 轮换，
 * 播放地址本身在 `*.hzjvlo.cn`。代理层用它做白名单。
 */
export const MEDIA_HOST_SUFFIXES = [
  'drleao.cn',
  'hzjvlo.cn',
  'ovscdns.com',
  'intlscdn.com',
  'dnsv1.com',
  'hnydns.com',
]

/* ───────────────────────── 错误 ───────────────────────── */

export class HghubError extends Error {
  constructor(message, { code, status, payload } = {}) {
    super(message)
    this.name = 'HghubError'
    this.code = code
    this.status = status
    this.payload = payload
  }
}

/* ───────────────────────── 小工具 ───────────────────────── */

/** 规整线路地址：必须是 http(s) 且带 host，去掉结尾斜杠。 */
export function normalizeBase(url) {
  try {
    const parsed = new URL(String(url).trim())
    if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) return undefined
    return parsed.origin
  } catch {
    return undefined
  }
}

/** 封面路径（相对或绝对）转完整地址。 */
export function coverURL(relativePath, base = IMAGE_BASE) {
  const raw = String(relativePath ?? '').trim()
  if (!raw) return ''
  if (/^https?:\/\//i.test(raw)) return raw
  return `${base.replace(/\/+$/, '')}/${raw.replace(/^\/+/, '')}`
}

/** 按魔数判断图片类型；不是浏览器认识的图片时返回空串。 */
export function imageKind(bytes) {
  if (!bytes || bytes.length < 12) return ''
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  // ISO-BMFF images share `ftyp`; only AVIF decodes in a browser. HEIC
  // (heic/heix/mif1…) must not pass as an image, or it skips conversion.
  if (bytes.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('latin1')
    return brand === 'avif' || brand === 'avis' ? 'image/avif' : ''
  }
  return ''
}

function stripPkcs7(buf) {
  if (buf.length === 0 || buf.length % 16 !== 0) return buf
  const pad = buf[buf.length - 1]
  if (pad > 0 && pad <= 16 && buf.length >= pad) {
    for (let i = buf.length - pad; i < buf.length; i += 1) if (buf[i] !== pad) return buf
    return buf.subarray(0, buf.length - pad)
  }
  return buf
}

/**
 * 解一张封面。封面都是 AES-128-CBC 密文，但 CDN 偶尔直接给明文，
 * 所以先看魔数，认得出就原样返回。
 */
export function decryptCover(bytes) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (imageKind(buf)) return buf
  if (buf.length === 0 || buf.length % 16 !== 0) {
    throw new HghubError('封面不是有效的 AES 密文（长度不是 16 的倍数）', { code: 'COVER_BAD_CIPHER' })
  }
  const decipher = createDecipheriv('aes-128-cbc', IMAGE_KEY, IMAGE_IV)
  decipher.setAutoPadding(false)
  const plain = stripPkcs7(Buffer.concat([decipher.update(buf), decipher.final()]))
  if (!imageKind(plain)) {
    throw new HghubError('封面解密后仍不是图片', { code: 'COVER_BAD_PLAIN' })
  }
  return plain
}

/** 主机是否属于播放链路（代理白名单用）。 */
export function isMediaHost(hostname) {
  const host = String(hostname ?? '').toLowerCase()
  if (!host) return false
  return MEDIA_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))
}

/** 图片 CDN 是否属于本站（封面代理白名单用）。 */
export function isImageHost(hostname) {
  if (isMediaHost(hostname)) return true
  const host = String(hostname ?? '').toLowerCase()
  return /(^|\.)(drleao\.cn|huangguoai\.com|huangguoai\.ai)$/.test(host)
}

/* ───────────────────────── HLS ───────────────────────── */

/**
 * 解析一份 m3u8：抽出 AES-128 的密钥地址、IV 与全部分片地址。
 * 相对路径按 `base`（这份播放列表自己的地址）解析。
 * `variants` 非空说明这是一份主列表（多清晰度），调用方应先跟进其中一条。
 */
export function parsePlaylist(text, base) {
  const lines = String(text ?? '').split(/\r?\n/)
  let keyURL = null
  let iv = null
  let method = null
  const segments = []
  const variants = []
  let pendingVariant = false
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXT-X-KEY')) {
      const methodMatch = line.match(/METHOD=([A-Z0-9-]+)/)
      if (methodMatch) method = methodMatch[1]
      const uriMatch = line.match(/URI="([^"]+)"/)
      if (uriMatch) keyURL = new URL(uriMatch[1], base).href
      const ivMatch = line.match(/IV=0x([0-9a-fA-F]+)/)
      if (ivMatch) iv = ivMatch[1].toLowerCase()
      continue
    }
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      pendingVariant = true
      continue
    }
    if (line.startsWith('#')) continue
    // 主列表里的裸地址是子播放列表；普通列表里的是分片。
    const target = new URL(line, base).href
    if (pendingVariant) {
      variants.push(target)
      pendingVariant = false
    } else {
      segments.push(target)
    }
  }
  return { method, keyURL, iv, segments, variants }
}

/** 取一集 HLS 播放列表的文本（不变，供 Host 再改写）。 */
export async function fetchPlaylistText(url, { userAgent = DEFAULT_UA, timeoutMs = 20000 } = {}) {
  const response = await fetch(url, {
    headers: { 'user-agent': userAgent, referer: new URL(url).origin + '/' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!response.ok) {
    throw new HghubError(`播放列表 HTTP ${response.status}`, { code: 'PLAYLIST_HTTP', status: response.status })
  }
  return response.text()
}

/* ───────────────────────── 线路 ───────────────────────── */

/** 去掉行尾 `//` 注释，但保留字符串里的 `//`（URL 里到处都是）。 */
function stripLineComments(body) {
  let out = ''
  let quote = null
  const chars = [...body]
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i]
    if (quote) {
      out += c
      if (c === quote) quote = null
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      out += c
      continue
    }
    if (c === '/' && chars[i + 1] === '/') {
      while (i < chars.length && chars[i] !== '\n') i += 1
      out += '\n'
      continue
    }
    out += c
  }
  return out
}

/** 取 JS 里 `var <name> = [ ... ]` 的字符串数组。 */
function jsStringArray(src, decl) {
  const at = String(src).indexOf(decl)
  if (at < 0) return []
  const rest = src.slice(at)
  const open = rest.indexOf('[')
  if (open < 0) return []
  const close = rest.indexOf(']', open)
  if (close < 0) return []
  return stripLineComments(rest.slice(open + 1, close))
    .split(',')
    .map((raw) => raw.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean)
}

/**
 * 从地址发布页抓镜像线路。页面只负责引入 `publish.js`，
 * 清单本身是 `var urls`（域名）+ `var subdomains`（子域前缀）的笛卡尔积。
 */
export async function fetchMirrors({ limit = 60, timeoutMs = 15000, userAgent = DEFAULT_UA, fetchImpl = globalThis.fetch } = {}) {
  const getText = async (url) => {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': userAgent, accept: 'text/html,application/javascript,*/*' },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) throw new HghubError(`HTTP ${response.status}`, { code: 'MIRROR_HTTP', status: response.status })
    return response.text()
  }

  const html = await getText(PUBLISH_PAGE)
  const scriptMatch = html.match(/src="([^"]*\.js[^"]*)"/)
  const scriptURL = new URL(scriptMatch ? scriptMatch[1] : 'publish.js', PUBLISH_PAGE).href
  const js = await getText(scriptURL)

  const domains = jsStringArray(js, 'var urls').map((value) => value.replace(/\/+$/, '')).filter(Boolean)
  const subs = jsStringArray(js, 'var subdomains')
  if (domains.length === 0) {
    throw new HghubError('地址发布页格式有变化：没找到镜像域名', { code: 'MIRROR_FORMAT' })
  }

  const items = []
  const seen = new Set()
  for (const domain of domains) {
    const hosts = subs.length ? subs.map((sub) => `${sub}.${domain}`) : [domain]
    for (const host of hosts) {
      if (seen.has(host)) continue
      seen.add(host)
      items.push({ url: `https://${host}`, host })
      if (items.length >= limit) return { source: PUBLISH_PAGE, script: scriptURL, items }
    }
  }
  return { source: PUBLISH_PAGE, script: scriptURL, items }
}

/** 可达性探测：只报结果，不做自动切换。 */
export async function probeLines(urls, { timeoutMs = 8000, userAgent = DEFAULT_UA, concurrency = 6 } = {}) {
  const out = []
  const queue = [...urls]
  const worker = async () => {
    while (queue.length) {
      const url = queue.shift()
      const base = normalizeBase(url) ?? url
      const started = Date.now()
      try {
        const response = await fetch(`${base}/`, {
          headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml' },
          signal: AbortSignal.timeout(timeoutMs),
        })
        out.push({ url: base, ok: response.status < 400, status: response.status, ms: Date.now() - started })
      } catch (error) {
        out.push({ url: base, ok: false, ms: Date.now() - started, error: String(error?.message ?? error) })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, urls.length) }, worker))
  return out
}

/* ───────────────────────── 档案 ───────────────────────── */

export function defaultProfilePath() {
  const dir = process.env.HGHUB_CONFIG_DIR || path.join(os.homedir(), '.config', 'hghub')
  return path.join(dir, 'profile.json')
}

/** 一个只存一行 JSON 的档案（0600）。Host 也可以传自己的 store 进来。 */
export function fileProfileStore(profilePath) {
  return {
    async load() {
      try {
        return JSON.parse(await fs.readFile(profilePath, 'utf8'))
      } catch (error) {
        if (error?.code === 'ENOENT') return null
        throw error
      }
    },
    async save(json) {
      await fs.mkdir(path.dirname(profilePath), { recursive: true, mode: 0o700 })
      const tmp = `${profilePath}.${process.pid}.tmp`
      await fs.writeFile(tmp, `${JSON.stringify(json, null, 2)}\n`, { mode: 0o600 })
      await fs.rename(tmp, profilePath)
    },
    async reset() {
      await fs.rm(profilePath, { force: true })
    },
  }
}

/* ───────────────────────── 客户端 ───────────────────────── */

export class Client {
  /**
   * @param {{
   *   base?: string, userAgent?: string, timeoutMs?: number, retries?: number,
   *   profile?: string, store?: {load:Function,save:Function,reset:Function},
   *   minIntervalMs?: number,
   * }} options
   */
  constructor(options = {}) {
    this.base = normalizeBase(options.base || FIXED_LINES[0].url) || FIXED_LINES[0].url
    this.userAgent = options.userAgent || DEFAULT_UA
    this.timeoutMs = options.timeoutMs ?? 20000
    this.retries = options.retries ?? 2
    /** 串行闸门：两次请求之间至少间隔这么久（上游按窗口限流）。 */
    this.minIntervalMs = options.minIntervalMs ?? 0
    this.store = options.store || fileProfileStore(options.profile || defaultProfilePath())
    this.token = ''
    this.user = null
    this._gate = Promise.resolve()
    this._lastRequestAt = 0
    this._profileLoaded = false
    this.fetch = options.fetch || ((...args) => globalThis.fetch(...args))
  }

  /* ---- 线路 ---- */

  /** 切换线路（下次请求即生效）。 */
  setBase(url) {
    const next = normalizeBase(url)
    if (!next) throw new HghubError('线路地址无效（需要 http(s)://域名）', { code: 'BAD_LINE' })
    this.base = next
    return next
  }

  /* ---- 会话 ---- */

  get isLoggedIn() {
    return Boolean(this.token)
  }

  async loadProfile() {
    if (this._profileLoaded) return this.token
    this._profileLoaded = true
    try {
      const saved = await this.store?.load?.()
      if (saved && typeof saved.token === 'string') {
        this.token = saved.token
        this.user = saved.user ?? null
        if (normalizeBase(saved.base)) this.base = normalizeBase(saved.base)
      }
    } catch {
      // 档案读不出来就当没登录，匿名浏览照常可用。
    }
    return this.token
  }

  async _persist() {
    try {
      await this.store?.save?.({ base: this.base, token: this.token, user: this.user })
    } catch {
      // 存不下来只影响下次启动要不要重新登录。
    }
  }

  async login(username, password) {
    const data = await this.request('/api/account/loginByPassword', {
      method: 'POST',
      body: { username, password },
      auth: false,
    })
    return this._adopt(data, '登录')
  }

  async register(username, password, email = '') {
    const body = { username, password, confirm_password: password }
    if (String(email).trim()) body.email = String(email).trim()
    const data = await this.request('/api/account/registerByPassword', { method: 'POST', body, auth: false })
    return this._adopt(data, '注册')
  }

  _adopt(data, action) {
    const token = data?.token
    if (!token) {
      throw new HghubError(`${action}返回缺少 token`, { code: 'NO_TOKEN', payload: data })
    }
    this.token = String(token)
    this.user = data?.user ?? null
    this._persist()
    return { token: this.token, user: this.user }
  }

  async logout() {
    if (this.token) await this.request('/api/account/logout', { method: 'POST' }).catch(() => {})
    this.token = ''
    this.user = null
    await this._persist()
  }

  /** 当前账号（会刷新缓存的用户资料）。 */
  async me() {
    const user = await this.request('/api/account/me', { auth: true })
    this.user = user
    this._persist()
    return user
  }

  /* ---- 请求层 ---- */

  async _waitTurn() {
    if (!this.minIntervalMs) return
    const turn = this._gate.then(async () => {
      const wait = this._lastRequestAt + this.minIntervalMs - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      this._lastRequestAt = Date.now()
    })
    this._gate = turn.catch(() => {})
    return turn
  }

  /**
   * 走边缘信封。`path` 自带查询串（与上游文档一致），`query` 只是拼装便利。
   * @param {string} requestPath
   * @param {{method?:string, query?:object, body?:object, auth?:boolean, noRetry?:boolean, _retried?:boolean, _attempt?:number}} options
   */
  async request(requestPath, options = {}) {
    await this.loadProfile()
    const method = (options.method || 'GET').toUpperCase()

    let requestTarget = requestPath
    if (options.query) {
      const search = new URLSearchParams()
      for (const [key, value] of Object.entries(options.query)) {
        if (value === undefined || value === null || value === '') continue
        search.set(key, String(value))
      }
      const encoded = search.toString()
      if (encoded) requestTarget += `${requestTarget.includes('?') ? '&' : '?'}${encoded}`
    }

    const token = options.auth === false ? '' : this.token
    const envelope = {
      method,
      path: requestTarget,
      body: options.body ? Buffer.from(JSON.stringify(options.body), 'utf8').toString('base64') : '',
      content_type: options.body ? 'application/json' : '',
    }
    const headers = {
      accept: 'application/json',
      'content-type': 'application/json',
      referer: `${this.base}/`,
      'user-agent': this.userAgent,
    }
    if (token) headers.authorization = `Bearer ${token}`

    await this._waitTurn()

    let response
    try {
      response = await this.fetch(`${this.base}/api/edge/request`, {
        method: 'POST',
        headers,
        body: JSON.stringify(envelope),
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    } catch (error) {
      const attempt = options._attempt ?? 0
      if (!options.noRetry && attempt < this.retries) {
        await sleep(350 * (attempt + 1))
        return this.request(requestPath, { ...options, _attempt: attempt + 1 })
      }
      throw new HghubError(`网络请求失败：${error?.message ?? error}`, { code: 'NETWORK' })
    }

    const status = response.status
    const text = await response.text()
    // 站点在边缘层就把未授权挡掉，且返回的仍是 JSON。
    if (status === 401 || status === 403) {
      if (token && !options._retried) {
        // token 过期：清掉后按匿名再试一次，读接口照样能取到数据。
        this.token = ''
        await this._persist()
        return this.request(requestPath, { ...options, _retried: true })
      }
      throw new HghubError('需要登录或登录已过期', { code: 'UNAUTHORIZED', status })
    }
    if (!response.ok) {
      const attempt = options._attempt ?? 0
      if (!options.noRetry && status >= 500 && attempt < this.retries) {
        await sleep(350 * (attempt + 1))
        return this.request(requestPath, { ...options, _attempt: attempt + 1 })
      }
      throw new HghubError(`HTTP ${status}：${text.slice(0, 160)}`, { code: 'HTTP', status, payload: text.slice(0, 400) })
    }

    let json
    try {
      json = JSON.parse(text)
    } catch {
      throw new HghubError(`响应不是 JSON：${text.slice(0, 160)}`, { code: 'BAD_JSON', payload: text.slice(0, 400) })
    }

    if (json && json.error) {
      throw new HghubError(String(json.error), { code: 'EDGE_ERROR', status })
    }
    if (Number(json?.status) !== 1) {
      const message = json?.msg || '接口返回失败'
      const code = /unauthorized/i.test(message) ? 'UNAUTHORIZED' : 'API_ERROR'
      throw new HghubError(message, { code, payload: json })
    }
    return json.data === undefined ? null : json.data
  }

  /* ---- 首页 / 目录 ---- */

  /** 首页聚合：轮播 + 精选 + 最新 + 分类推荐 + 专题。 */
  async home() {
    const data = await this.request('/api/home')
    return {
      banners: (data?.banners ?? []).map((row) => ({ ...row, image: coverURL(row.image) })),
      featured: (data?.featured ?? []).map(toCard),
      latest: (data?.latest ?? []).map(toCard),
      categories: (data?.cate_rec ?? []).map((row) => ({
        id: row.cate_id,
        name: row.cate_name,
        items: (row.videos ?? []).map(toCard),
      })),
      topics: data?.topic_rec ?? [],
    }
  }

  /** 全站列表（默认按热度排）。 */
  async feed({ page = 1, size = 20 } = {}) {
    const data = await this.request('/api/videos', { query: { page, size } })
    return toPage(data)
  }

  /** 频道列表（`CATEGORIES` 里的 cate）。 */
  async category(cate, { page = 1, size = 20 } = {}) {
    const data = await this.request(`/api/videos/category/${encodeURIComponent(cate)}`, { query: { page, size } })
    return toPage(data)
  }

  /** 榜：hot / recommend / potential。 */
  async rank(kind = 'hot') {
    const name = RANKS.includes(kind) ? kind : 'hot'
    const data = await this.request(`/api/ranks/${name}`)
    return {
      type: data?.type ?? name,
      items: (data?.items ?? []).map((row) => ({
        rank: row.rank,
        id: row.video_id,
        title: row.title,
        cover: coverURL(row.cover),
        tags: row.tags ?? [],
        score: row.score,
        category: row.cate_name,
        episodes: row.episode_count,
        finished: Boolean(row.is_finished),
        metricLabel: row.metric_label,
        metricValue: row.metric_value,
        metrics: row.metrics ?? {},
      })),
    }
  }

  /** 标签字典（题材 / 男频 / 女频 …）。 */
  async tags() {
    const data = await this.request('/api/tags')
    return {
      categories: (data?.categories ?? []).map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        tags: row.tags ?? [],
      })),
      hot: data?.hot ?? [],
    }
  }

  /** 搜索。 */
  async search(keyword, { page = 1, size = 20 } = {}) {
    const q = String(keyword ?? '').trim()
    if (!q) return { keyword: '', items: [], page: 1, pages: 0, total: 0 }
    const data = await this.request('/api/search', { query: { q, page, size } })
    return { keyword: data?.keyword ?? q, ...toPage(data) }
  }

  /* ---- 详情 / 分集 ---- */

  /** 短剧详情，分集列表就在里面。 */
  async getVideo(id) {
    const data = await this.request(`/api/videos/${encodeURIComponent(id)}`)
    if (!data || data.id === undefined) {
      throw new HghubError('视频不存在', { code: 'NOT_FOUND' })
    }
    return {
      id: data.id,
      title: data.title,
      description: data.description ?? '',
      cover: coverURL(data.cover),
      tags: data.tags ?? [],
      tagLinks: data.tag_links ?? [],
      score: data.score,
      episodes: Number(data.episode_count ?? data.episodes?.length ?? 0),
      totalEpisodes: Number(data.total_episodes ?? 0),
      finished: Boolean(data.is_finished),
      duration: Number(data.duration ?? 0),
      createdAt: data.created_at,
      counts: data.counts ?? {},
      author: data.author ?? null,
      interaction: data.interaction ?? null,
      videoType: data.video_type,
      episodeList: (data.episodes ?? [])
        .map((ep) => ({
          number: Number(ep.ep_num),
          title: ep.title || `第${ep.ep_num}集`,
          duration: Number(ep.duration ?? 0),
          status: Number(ep.status ?? 0),
          playable: Number(ep.status ?? 1) === 1,
        }))
        .sort((a, b) => a.number - b.number),
    }
  }

  /**
   * 分集列表（`getVideo` 的薄封装，形状与旧 SDK 对齐）。
   * 本片源的“集”没有独立 id，用 `${videoId}_${ep}` 拼一个稳定的复合 id。
   */
  async listEpisodes(videoId, { pageNumber = 1, pageSize = 200 } = {}) {
    const detail = await this.getVideo(videoId)
    const rows = detail.episodeList
    const start = (pageNumber - 1) * pageSize
    const slice = rows.slice(start, start + pageSize)
    return {
      total: rows.length,
      hasMore: start + slice.length < rows.length,
      items: slice.map((ep) => ({
        id: episodeId(videoId, ep.number),
        number: ep.number,
        title: ep.title,
        duration: ep.duration,
        playable: ep.playable,
      })),
    }
  }

  /* ---- 播放 ---- */

  /** 一集的播放信息（地址带新的签名，通常一分钟级别有效）。 */
  async getPlay(videoId, ep) {
    const data = await this.request(`/api/videos/${encodeURIComponent(videoId)}/play`, {
      query: { ep, page_texts: 0 },
    })
    if (!data || !data.video_url) {
      throw new HghubError('这一集没有播放地址（可能已下架）', { code: 'NO_VIDEO', payload: data })
    }
    return {
      videoId: Number(data.id ?? videoId),
      ep: Number(data.ep_num ?? ep),
      title: data.title,
      duration: Number(data.duration ?? 0),
      videoUrl: data.video_url,
      videoUrlHevc: data.video_url_hevc || undefined,
    }
  }

  /**
   * 解析一集：播放地址 + 分片 + AES-128 密钥。
   * @param {string|number} videoId
   * @param {number} [ep]
   */
  async resolvePlayback(videoId, ep) {
    let target = videoId
    if (ep === undefined && typeof videoId === 'string' && /^\d+_\d+$/.test(videoId)) {
      const [id, number] = videoId.split('_')
      target = { videoId: id, ep: number }
    }
    const { videoId: id, ep: number } = typeof target === 'object' ? target : { videoId: target, ep }
    if (!Number.isFinite(Number(number)) || Number(number) < 1) {
      throw new HghubError(`集号无效：${number}`, { code: 'BAD_EPISODE' })
    }
    const info = await this.getPlay(id, number)
    let playlistText = await fetchPlaylistText(info.videoUrl, { userAgent: this.userAgent, timeoutMs: this.timeoutMs })
    let base = info.videoUrl
    let parsed = parsePlaylist(playlistText, base)
    // 主列表（多清晰度）：跟第一条子列表，和 Host 的 serveManifest 行为一致。
    if (parsed.segments.length === 0 && parsed.variants.length > 0) {
      base = parsed.variants[0]
      playlistText = await fetchPlaylistText(base, { userAgent: this.userAgent, timeoutMs: this.timeoutMs })
      parsed = parsePlaylist(playlistText, base)
    }
    let key = null
    if (parsed.keyURL) {
      const response = await fetch(parsed.keyURL, {
        headers: { 'user-agent': this.userAgent, referer: `${new URL(parsed.keyURL).origin}/` },
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      if (response.ok) key = Buffer.from(await response.arrayBuffer()).toString('hex')
    }
    return { ...info, playlistURL: base, playlistText, ...parsed, key }
  }

  /** 某一集的 HLS 播放列表地址（分片与 key 都是 CDN 绝对地址）。 */
  playlistURL(videoUrl) {
    return videoUrl
  }

  /** 复合集 id（`117_3`）直接取播放信息，Host 的路由用这个。 */
  async getEpisode(episodeIdValue) {
    const parsed = parseEpisodeId(episodeIdValue)
    if (!parsed) throw new HghubError(`集 id 无效：${episodeIdValue}`, { code: 'BAD_EPISODE_ID' })
    return this.getPlay(parsed.videoId, parsed.ep)
  }

  /** 相对封面路径转完整地址（Host 的列表构造里用）。 */
  coverURL(relativePath) {
    return coverURL(relativePath)
  }

  /** 下载并解密一张封面，返回 { kind, bytes }。 */
  async fetchCover(url, { timeoutMs = this.timeoutMs } = {}) {
    const response = await fetch(url, {
      headers: { 'user-agent': this.userAgent, referer: `${this.base}/` },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      throw new HghubError(`封面 HTTP ${response.status}`, { code: 'COVER_HTTP', status: response.status })
    }
    const bytes = decryptCover(Buffer.from(await response.arrayBuffer()))
    return { kind: imageKind(bytes) || 'image/jpeg', bytes }
  }

  /* ---- 吃瓜帖子 ---- */

  async posts({ page = 1, size = 20 } = {}) {
    const data = await this.request('/api/posts', { query: { page, size } })
    return toPage(data)
  }

  async post(id) {
    return this.request(`/api/posts/${encodeURIComponent(id)}`)
  }

  async comments(videoId, ep = 1, { page = 1, size = 20 } = {}) {
    return this.request(`/api/videos/${encodeURIComponent(videoId)}/comments`, { query: { ep, page, size } })
  }

  /* ---- 网络自检 ---- */

  /** DNS / HTTP / 线路快照，用来远程判断“打不开”是网络还是上游。 */
  async diagnose() {
    const host = new URL(this.base).hostname
    const started = Date.now()
    let http
    try {
      const response = await fetch(`${this.base}/`, {
        headers: { 'user-agent': this.userAgent },
        signal: AbortSignal.timeout(12000),
      })
      http = { status: response.status, ms: Date.now() - started }
    } catch (error) {
      http = { error: String(error?.message ?? error), ms: Date.now() - started }
    }
    return {
      base: this.base,
      host,
      http,
      loggedIn: Boolean(this.token),
      mediaHosts: MEDIA_HOST_SUFFIXES,
      imageBase: IMAGE_BASE,
    }
  }
}

/* ───────────────────────── 数据整形 ───────────────────────── */

/** `117` + `3` → 一个可安全放进 URL 的复合集 id。 */
export function episodeId(videoId, ep) {
  return `${videoId}_${ep}`
}

/** 复合集 id 拆回 { videoId, ep }；拆不出来返回 undefined。 */
export function parseEpisodeId(value) {
  const match = String(value ?? '').match(/^([0-9A-Za-z_-]+)_(\d+)$/)
  return match ? { videoId: match[1], ep: Number(match[2]) } : undefined
}

/** 列表行统一成 Host 需要的形状。 */
export function toCard(row) {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    description: row.desc ?? row.description ?? '',
    cover: coverURL(row.cover),
    tags: row.tags ?? [],
    score: row.score,
    episodes: Number(row.episode_count ?? row.episode_count ?? 0),
    hot: Number(row.hot ?? 0),
    finished: Boolean(row.is_finished),
    categoryId: row.cate_id,
    playAt: row.play_at,
  }
}

function toPage(data) {
  const pagination = data?.pagination ?? {}
  return {
    items: (data?.items ?? []).map(toCard).filter(Boolean),
    page: Number(pagination.page ?? 1),
    pages: Number(pagination.pages ?? 0),
    size: Number(pagination.size ?? 0),
    total: Number(pagination.total ?? 0),
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 建一个客户端；匿名浏览不需要登录，所以这里不触发任何请求。 */
export async function createClient(options = {}) {
  const client = new Client(options)
  await client.loadProfile()
  return client
}

export default createClient
