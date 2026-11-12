import { constants, openSync, closeSync, fstatSync, fchmodSync, readFileSync, writeFileSync, fsyncSync, renameSync, unlinkSync, mkdirSync, lstatSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import qrcode from 'qrcode-generator'
import { PlayerError } from '../errors.mjs'

const token = () => randomBytes(24).toString('base64url')
const failure = () => new PlayerError('B 站登录暂时不可用，请重试', 503)
const names = ['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3', 'buvid4', 'b_nut', 'sid']
const validCookie = value => typeof value === 'string' && value.length <= 16384 && !/[\r\n\x00]/.test(value)

// Private, atomic, per-provider storage. Never put credentials into preferences,
// the catalog, tool results or diagnostics. A blank record also overrides env cookies.
export class BilibiliCredentials {
  constructor(directory, fallback = '') {
    this.directory = join(directory, 'account')
    this.path = join(this.directory, 'session.json')
    this.fallback = validCookie(fallback) ? fallback : ''
  }
  read() {
    let fd
    try {
      if (lstatSync(this.directory).isSymbolicLink()) throw Error('UNSAFE')
      if (lstatSync(this.path).isSymbolicLink()) throw Error('UNSAFE')
      fd = openSync(this.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0))
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 20000 || stat.nlink !== 1 ||
          (process.platform !== 'win32' && stat.uid !== process.getuid())) throw Error('UNSAFE')
      if (process.platform !== 'win32') fchmodSync(fd, 0o600)
      let data
      try { data = JSON.parse(readFileSync(fd, 'utf8')) } catch { return { revision: 'invalid', cookie: '' } }
      return data.version === 1 && /^[\w-]{32}$/.test(data.revision) && validCookie(data.cookie)
        ? { revision: data.revision, cookie: data.cookie } : { revision: 'invalid', cookie: '' }
    } catch (error) {
      if (error.code === 'ENOENT') return { revision: 'initial', cookie: this.fallback }
      throw new PlayerError('本机登录态无法读取，请检查目录权限', 503)
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  save(cookie) {
    const revision = token()
    let path, fd
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      if (lstatSync(this.directory).isSymbolicLink()) throw Error('UNSAFE')
      if (process.platform !== 'win32') chmodSync(this.directory, 0o700)
      path = join(this.directory, '.' + revision + '.tmp')
      fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      writeFileSync(fd, JSON.stringify({ version: 1, revision, cookie }))
      fsyncSync(fd); closeSync(fd); fd = undefined
      renameSync(path, this.path)
      return { revision, cookie }
    } catch { throw new PlayerError('登录状态暂未保存，请检查本机目录权限', 503) }
    finally {
      if (fd !== undefined) closeSync(fd)
      if (path) try { unlinkSync(path) } catch {}
    }
  }
}

function collectCookies(jar, headers) {
  const lines = headers?.getSetCookie?.() ?? headers?.['set-cookie'] ?? []
  for (const line of Array.isArray(lines) ? lines : [lines]) {
    // Axios may join Set-Cookie. Split only before a known cookie, not Expires dates.
    for (const item of String(line).split(/,\s*(?=(?:SESSDATA|bili_jct|DedeUserID(?:__ckMd5)?|buvid[34]|b_nut|sid)=)/)) {
      const pair = item.split(';', 1)[0], at = pair.indexOf('=')
      const name = pair.slice(0, at).trim(), value = pair.slice(at + 1).trim()
      if (at > 0 && names.includes(name) && value && validCookie(value) && !/[;\s]/.test(value)) jar.set(name, value)
    }
  }
}
const cookieString = jar => names.filter(name => jar.has(name)).map(name => name + '=' + jar.get(name)).join('; ')
function loginURL(input, qr = false) {
  let url
  try { url = new URL(input) } catch { throw failure() }
  const allowed = qr
    ? ['passport.bilibili.com', 'account.bilibili.com'].includes(url.hostname) &&
      ['/qrcode/h5/login', '/h5/account-h5/auth/scan-web'].includes(url.pathname)
    : ['passport.biligame.com', 'passport.bilibili.com'].includes(url.hostname) &&
      ['/crossDomain', '/x/passport-login/web/crossDomain', '/x/passport-login/web/sso'].includes(url.pathname)
  if (!allowed || url.protocol !== 'https:' || url.port || url.username || url.password || url.href.length > 8192) throw failure()
  return url
}

export class BilibiliAuth {
  constructor(context, request, { cookie = '', now = Date.now, onChange = () => {} } = {}) {
    this.context = context; this.request = request; this.now = now; this.onChange = onChange
    this.credentials = new BilibiliCredentials(context.dataDir, cookie)
    this.sessions = new Map()
  }
  cookie() { return this.credentials.read().cookie }
  revision() { return this.credentials.read().revision }
  async status() {
    const current = this.credentials.read()
    if (!current.cookie) return { status: current.revision === 'invalid' ? 'expired' : 'signed-out' }
    if (this.cached?.revision === current.revision && this.cached.until > this.now()) return this.cached.state
    let state
    try { state = this.profile(await this.request('fetchLoginStatus', {}, undefined, { cookie: current.cookie })) }
    catch (error) {
      if (error.code !== 'AUTHENTICATION_REQUIRED') throw error
      state = { status: 'expired' }
    }
    if (this.credentials.read().revision !== current.revision) return this.status()
    this.cached = { revision: current.revision, until: this.now() + 30000, state }
    return state
  }
  profile(data) {
    if (data?.isLogin !== true) return { status: 'expired' }
    return { status: 'signed-in', name: String(data.uname || 'B 站账号').slice(0, 80),
      vip: data.vipStatus === 1 || data.vip?.status === 1 }
  }
  live(session) {
    return !session.controller.signal.aborted && !this.context.signal?.aborted && session.expiresAt > this.now() &&
      this.credentials.read().revision === session.revision && this.sessions.get(session.id) === session
  }
  cancel(owner, id) {
    const session = this.sessions.get(id)
    if (session?.owner === owner) { session.controller.abort(); this.sessions.delete(id) }
    return { status: 'cancelled' }
  }
  async start(owner) {
    for (const session of this.sessions.values()) if (session.owner === owner || session.expiresAt <= this.now()) this.cancel(session.owner, session.id)
    if (this.sessions.size >= 8) throw new PlayerError('登录请求较多，请稍后重试', 429)
    const session = { id: token(), owner, revision: this.credentials.read().revision, controller: new AbortController(),
      expiresAt: this.now() + 180000, state: { status: 'waiting' }, lastPoll: -Infinity }
    this.sessions.set(session.id, session)
    try {
      const data = await this.request('requestLoginQrcode', {}, session.controller.signal, { cookie: '' })
      if (!this.live(session)) return { status: 'cancelled' }
      if (typeof data?.qrcode_key !== 'string' || !/^[\w-]{1,256}$/.test(data.qrcode_key)) throw failure()
      const qr = qrcode(0, 'M'); qr.addData(loginURL(data.url, true).href); qr.make()
      session.key = data.qrcode_key
      return { ...session.state, loginId: session.id, expiresAt: session.expiresAt,
        svg: qr.createSvgTag({ cellSize: 4, margin: 16, scalable: true }) }
    } catch (error) { this.cancel(owner, session.id); throw error }
  }
  async poll(owner, id) {
    const session = this.sessions.get(id)
    if (!session || session.owner !== owner) return { status: 'cancelled' }
    if (!this.live(session)) { this.cancel(owner, id); return { status: 'expired' } }
    if (session.pending) return session.pending
    if (this.now() - session.lastPoll < 1800) return session.state
    session.lastPoll = this.now()
    session.pending = this.check(session).catch(error => {
      if (!this.live(session)) return { status: 'cancelled' }
      throw error
    }).finally(() => { session.pending = undefined })
    return session.pending
  }
  async check(session) {
    const signal = session.controller.signal
    const result = await this.request('checkQrcodeStatus', { qrcode_key: session.key }, signal, { cookie: '' })
    if (!this.live(session)) return { status: 'cancelled' }
    const data = result?.data
    if (data?.code === 86101 || data?.code === 86090) return session.state = { status: data.code === 86101 ? 'waiting' : 'scanned' }
    if (data?.code === 86038) { this.cancel(session.owner, session.id); return { status: 'expired' } }
    if (data?.code !== 0) throw failure()
    const jar = new Map()
    collectCookies(jar, result.headers)
    if (!jar.has('SESSDATA') && data.url) {
      let target = loginURL(data.url)
      for (const name of names) {
        const value = target.searchParams.get(name)
        if (value && validCookie(value) && !/[;\s]/.test(value)) jar.set(name, value)
      }
      // New Bilibili replies carry an SSO ticket. Follow only the explicit passport
      // paths, collecting response cookies internally, without forwarding old cookies.
      for (let hop = 0; !jar.has('SESSDATA') && hop < 4; hop++) {
        if (!this.live(session)) return { status: 'cancelled' }
        const response = await this.context.fetch(target, { signal, followRedirects: false,
          headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' } })
        collectCookies(jar, response.headers)
        if (jar.has('SESSDATA')) break
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        target = loginURL(new URL(response.headers.get('location'), target))
      }
    }
    if (!jar.has('SESSDATA')) throw new PlayerError('B 站未返回有效登录态，请重新扫码', 503)
    const cookie = cookieString(jar)
    const state = this.profile(await this.request('fetchLoginStatus', {}, signal, { cookie }))
    if (!this.live(session)) return { status: 'cancelled' }
    if (state.status !== 'signed-in') throw new PlayerError('B 站未返回有效登录态，请重新扫码', 503)
    const stored = this.credentials.save(cookie)
    this.cached = { revision: stored.revision, until: this.now() + 30000, state }
    this.dispose(); this.onChange()
    return state
  }
  logout() {
    this.credentials.save('')
    this.cached = undefined; this.dispose(); this.onChange()
    return { status: 'signed-out' }
  }
  dispose() { for (const session of this.sessions.values()) session.controller.abort(); this.sessions.clear() }
}
