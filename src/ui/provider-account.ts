import { call } from './api'
import { tr } from './locale'

type AuthState = { status: 'signed-out' | 'signed-in' | 'expired' | 'waiting' | 'scanned' | 'cancelled'; name?: string; vip?: boolean; loginId?: string; svg?: string; expiresAt?: number }
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

export class ProviderAccount {
  source = ''
  generation = 0
  loginId?: string
  imageURL?: string
  timer?: ReturnType<typeof setTimeout>
  refreshTimer?: ReturnType<typeof setTimeout>
  constructor(private changed: (signedIn: boolean) => Promise<void>) {
    el('accountLogin').onclick = () => void this.start()
    el('accountCancel').onclick = () => { this.cancel(); void this.refresh() }
    el('accountLogout').onclick = () => void this.logout()
  }
  async show(source?: string) {
    this.hide()
    if (!source) return
    this.source = source
    el('providerAccount').hidden = false
    await this.refresh()
  }
  hide() {
    this.cancel()
    clearTimeout(this.refreshTimer)
    this.source = ''
    el('providerAccount').hidden = true
  }
  cancel() {
    ++this.generation
    clearTimeout(this.timer)
    if (this.loginId) void call('cancel_provider_login', { source: this.source, loginId: this.loginId }, 4000).catch(() => {})
    this.loginId = undefined
    if (this.imageURL) URL.revokeObjectURL(this.imageURL)
    this.imageURL = undefined
    el<HTMLImageElement>('accountQr').removeAttribute('src')
    el('accountQrArea').hidden = true
    el('accountCancel').hidden = true
  }
  busy(value: boolean) {
    el<HTMLButtonElement>('accountLogin').disabled = value
    el<HTMLButtonElement>('accountLogout').disabled = value
  }
  message(message: string) { el('accountStatus').textContent = tr(message) }
  render(state: AuthState) {
    const signedIn = state.status === 'signed-in'
    el('accountLogin').hidden = signedIn
    el('accountLogin').textContent = tr('扫码登录')
    el('accountLogout').hidden = !signedIn
    el('accountName').textContent = signedIn ? state.name || tr('B 站账号') : tr('B 站账号')
    this.message(signedIn ? state.vip ? '已登录 · 大会员' : '已登录' : state.status === 'expired' ? '登录已失效，请重新扫码' : '未登录，可观看允许匿名访问的番剧')
  }
  async refresh() {
    const source = this.source, generation = this.generation
    if (!source || this.loginId) return
    clearTimeout(this.refreshTimer)
    this.busy(true)
    try {
      const state = await call<AuthState>('get_provider_auth', { source })
      if (generation === this.generation && source === this.source) this.render(state)
    } catch { if (generation === this.generation) this.message('登录状态暂时无法确认，请重试') }
    finally {
      if (generation === this.generation && this.source) {
        this.busy(false)
        this.refreshTimer = setTimeout(() => void this.refresh(), 15000)
      }
    }
  }
  async start() {
    this.cancel()
    clearTimeout(this.refreshTimer)
    const generation = this.generation, source = this.source
    this.busy(true); this.message('正在生成登录二维码…')
    try {
      const state = await call<AuthState>('start_provider_login', { source })
      if (generation !== this.generation || source !== this.source) {
        if (state.loginId) void call('cancel_provider_login', { source, loginId: state.loginId }).catch(() => {})
        return
      }
      if (!state.loginId || !state.svg || !state.expiresAt) throw Error('B 站登录暂时不可用，请重试')
      this.loginId = state.loginId
      el<HTMLImageElement>('accountQr').alt = tr('哔哩哔哩登录二维码')
      this.imageURL = URL.createObjectURL(new Blob([state.svg], { type: 'image/svg+xml' }))
      el<HTMLImageElement>('accountQr').src = this.imageURL
      el('accountQrArea').hidden = false
      el('accountCancel').hidden = false
      el('accountLogin').textContent = tr('刷新二维码')
      this.message('请用哔哩哔哩 App 扫码并确认登录')
      this.timer = setTimeout(() => void this.poll(generation, state.expiresAt!), 2000)
    } catch (error) { if (generation === this.generation) this.message(error instanceof Error ? error.message : 'B 站登录暂时不可用，请重试') }
    finally { if (generation === this.generation) this.busy(false) }
  }
  async poll(generation: number, expiresAt: number) {
    if (generation !== this.generation || !this.loginId) return
    if (Date.now() >= expiresAt) { this.cancel(); this.message('二维码已过期，请刷新后重试'); return }
    try {
      const state = await call<AuthState>('poll_provider_login', { source: this.source, loginId: this.loginId })
      if (generation !== this.generation) return
      if (state.status === 'signed-in') {
        this.cancel(); this.render(state)
        await this.changed(true).catch(() => {})
        this.refreshTimer = setTimeout(() => void this.refresh(), 15000)
        return
      }
      if (state.status === 'expired' || state.status === 'cancelled') {
        this.cancel(); this.message('二维码已过期，请刷新后重试'); return
      }
      this.message(state.status === 'scanned' ? '已扫码，请在手机上确认' : '请用哔哩哔哩 App 扫码并确认登录')
    } catch {
      if (generation !== this.generation) return
      this.message('登录请求暂时失败，正在重试…')
    }
    if (generation === this.generation) this.timer = setTimeout(() => void this.poll(generation, expiresAt), 2200)
  }
  async logout() {
    this.cancel()
    clearTimeout(this.refreshTimer)
    const generation = this.generation
    this.busy(true)
    try {
      const state = await call<AuthState>('logout_provider', { source: this.source })
      if (generation !== this.generation) return
      this.render(state)
      await this.changed(false).catch(() => {})
    } catch { if (generation === this.generation) this.message('退出登录失败，请重试') }
    finally { if (generation === this.generation) this.busy(false) }
  }
}
