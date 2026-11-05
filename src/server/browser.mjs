import { createServer } from 'node:http'
import { createReadStream, statSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { projectRoot } from './paths.mjs'
import { PlayerError, message } from './errors.mjs'
import { secret } from './service.mjs'

export function range(header, size) {
  if (header === undefined) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header)
  if (!m || (!m[1] && !m[2]) || size === 0) return false
  const a = Number(m[1]),
    b = Number(m[2])
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b)) return false
  const start = m[1] ? a : Math.max(0, size - b)
  const end = m[1] && m[2] ? Math.min(size - 1, b) : size - 1
  return start >= size || end < start ? false : [start, end]
}
async function body(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json')
    throw new PlayerError('需要 JSON 请求', 415)
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    bytes += chunk.length
    if (bytes > 16384) throw new PlayerError('请求过大', 413)
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString())
  } catch {
    throw new PlayerError('请求格式无效')
  }
}
const pairHTML = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>红果短剧 · 连接分屏</title><p>正在连接本机会话…</p><script nonce="__NONCE__">
(async()=>{const ticket=location.hash.slice(1);history.replaceState(null,'','/pair');
try {const r=await fetch('/exchange',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})});
if(!r.ok)throw Error();location.replace((await r.json()).page);}catch{document.querySelector('p').textContent='分屏链接已过期或已使用。请回到短剧面板重新获取。';}})()
</script></html>`
export class BrowserServer {
  constructor(service) {
    this.service = service
    this.tickets = new Map()
    this.sessions = new Map()
  }
  async listen() {
    if (!this.starting) {
      this.server = createServer((req, res) =>
        this.request(req, res).catch((e) => {
          if (res.headersSent) {
            res.destroy()
            return
          }
          res.writeHead(e instanceof PlayerError ? e.status : 503, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ error: message(e) }))
        }),
      )
      this.server.headersTimeout = 10000
      this.server.requestTimeout = 15000
      this.starting = new Promise((ok, fail) => {
        this.server.once('error', fail)
        this.server.listen(0, '127.0.0.1', () => {
          this.origin = 'http://127.0.0.1:' + this.server.address().port
          ok()
        })
      }).catch((e) => {
        this.starting = null
        throw e
      })
    }
    return this.starting
  }
  prune() {
    for (const map of [this.sessions, this.tickets])
      for (const [key, obj] of map) if (obj.expires < Date.now()) map.delete(key)
  }
  async pair(scope) {
    await this.listen()
    this.prune()
    const ticket = secret()
    this.tickets.set(ticket, { scope, expires: Date.now() + 60000 })
    return { url: this.origin + '/pair#' + ticket, expiresIn: 60 }
  }
  async request(req, res) {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    if (req.headers.host !== new URL(this.origin).host) throw new PlayerError('主机无效', 403)
    if (req.method === 'POST' && req.headers.origin !== this.origin)
      throw new PlayerError('请求来源无效', 403)
    const path = req.url,
      nonce = randomBytes(16).toString('base64')
    res.setHeader(
      'Content-Security-Policy',
      `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
    )
    const html = (text) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(text.replaceAll('__NONCE__', nonce))
    }
    const json = (value) => {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(value))
    }
    if (path === '/pair' && req.method === 'GET') return html(pairHTML)
    this.prune()
    if (path === '/exchange' && req.method === 'POST') {
      const input = await body(req),
        item = this.tickets.get(input?.ticket)
      if (!item || item.expires < Date.now()) throw new PlayerError('分屏链接无效', 403)
      this.tickets.delete(input.ticket)
      const id = randomBytes(12).toString('hex'),
        key = secret(),
        page = '/p/' + id + '/'
      this.sessions.set(id, { ...item.scope, key, grants: new Set(), expires: Date.now() + 12 * 3600000 })
      res.setHeader('Set-Cookie', 'hg=' + key + '; Path=' + page + '; HttpOnly; SameSite=Strict')
      return json({ page })
    }
    const match = /^\/p\/([a-f0-9]{24})\/(.*)$/.exec(path)
    const session = match && this.sessions.get(match[1])
    if (!session || !(req.headers.cookie || '').split(/;\s*/).includes('hg=' + session.key))
      throw new PlayerError('请从会话面板重新打开分屏', 401)
    session.expires = Date.now() + 12 * 3600000
    const route = match[2]
    if (!route && req.method === 'GET')
      return html(
        readFileSync(join(projectRoot, 'dist/ui/player.html'), 'utf8').replace(
          'data-host="panel"',
          'data-host="browser"',
        ),
      )
    if (route === 'context' && req.method === 'GET')
      return json({
        identified: !!session.sessionId,
        turnId: session.fixedTurn,
        selection: session.selection,
      })
    if (route.startsWith('api/') && req.method === 'POST')
      return json(await this.service.call(session, route.slice(4), await body(req), true))
    if (route.startsWith('media/') && ['GET', 'HEAD'].includes(req.method)) {
      const id = route.slice(6)
      if (!session.grants.has(id)) throw new PlayerError('请先选择该集', 403)
      const file = this.service.catalog.cache?.path(id)
      if (!file) throw new PlayerError('素材待重新准备', 404)
      const size = statSync(file, { throwIfNoEntry: false })?.size
      if (!size) throw new PlayerError('缓存已清理，请重新准备该集', 404)
      this.service.catalog.cache?.hold(id)
      const part = range(req.headers.range, size)
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Content-Type', 'video/mp4')
      if (part === false) {
        res.writeHead(416, { 'Content-Range': 'bytes */' + size })
        return res.end()
      }
      const [start, end] = part || [0, size - 1]
      if (part) res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`)
      res.writeHead(part ? 206 : 200, { 'Content-Length': end - start + 1 })
      if (req.method === 'HEAD') return res.end()
      const stream = createReadStream(file, { start, end })
      const keep = setInterval(() => this.service.catalog.cache?.hold(id), 30000)
      res.on('close', () => {
        clearInterval(keep)
        stream.destroy()
      })
      stream.on('error', () => res.destroy())
      stream.pipe(res)
      return
    }
    throw new PlayerError('找不到该页面', 404)
  }
  close() {
    this.server?.closeAllConnections()
    this.server?.close()
  }
}
