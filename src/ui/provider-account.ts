import { call } from './api'
import { tr } from './locale'

type AuthState = { status: 'signed-out' | 'signed-in' | 'expired' | 'waiting' | 'scanned' | 'cancelled' | 'unknown'; name?: string; vip?: boolean; loginId?: string; svg?: string; expiresAt?: number }
type Provider = { id: string; name: string }
type Row = { button: HTMLButtonElement; name: HTMLElement; status: HTMLElement }
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

export class ProviderAccount {
  source = ''
  generation = 0
  loginId?: string
  imageURL?: string
  timer?: ReturnType<typeof setTimeout>
  refreshTimer?: ReturnType<typeof setTimeout>
  private listing = 0
  private disabled = false
  private providers = new Map<string, Provider>()
  private rows = new Map<string, Row>()
  private states = new Map<string, AuthState>()
  private revisions = new Map<string, number>()
  private scroll = 0
  constructor(private changed: (source: string, signedIn: boolean) => Promise<void>) {
    el('accountBack').onclick = () => { this.back() }
    el('accountLogin').onclick = () => void this.start()
    el('accountCancel').onclick = () => { this.back() }
    el('accountLogout').onclick = () => void this.logout()
  }
  /** Reconcile rows without replacing focused controls or restarting a QR login. */
  sync(providers: Provider[], disabled = false) {
    if (!providers.length) { this.hide(); return }
    this.disabled = disabled
    const changed = JSON.stringify([...this.providers.values()]) !== JSON.stringify(providers)
    if (this.source && !providers.some(provider => provider.id === this.source)) this.back(false)
    this.providers = new Map(providers.map(provider => [provider.id, provider]))
    if (changed) {
      ++this.listing
      for (const id of this.rows.keys()) if (!this.providers.has(id)) { this.rows.delete(id); this.states.delete(id) }
      for (const provider of providers) {
        if (!this.rows.has(provider.id)) {
          const button = document.createElement('button'), mark = document.createElement('span')
          const info = document.createElement('span'), name = document.createElement('span'), status = document.createElement('span')
          const arrow = document.createElement('span')
          button.type = 'button'; button.className = 'accountRow'; button.dataset.source = provider.id
          button.setAttribute('aria-controls', 'accountPage')
          mark.className = 'accountMark'; mark.setAttribute('aria-hidden', 'true')
          mark.textContent = provider.id === 'bilibili' ? 'B' : provider.name.slice(0, 1)
          info.className = 'accountRowInfo'; name.className = 'accountRowName'; status.className = 'accountRowStatus'
          arrow.className = 'accountArrow'; arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true')
          info.append(name, status); button.append(mark, info, arrow)
          button.onclick = () => void this.open(provider.id)
          this.rows.set(provider.id, { button, name, status })
        }
        this.rows.get(provider.id)!.name.textContent = tr(provider.name)
      }
      el('accountRows').replaceChildren(...providers.map(provider => this.rows.get(provider.id)!.button))
    }
    el('providerAccount').hidden = false
    for (const id of this.rows.keys()) this.renderRow(id)
    if (changed) void this.refresh()
  }
  private renderRow(id: string) {
    const row = this.rows.get(id), state = this.states.get(id)
    if (!row) return
    row.button.disabled = this.disabled
    row.status.textContent = !state ? tr('正在读取…') : state.status === 'signed-in'
      ? [state.name, tr(state.vip ? '大会员' : '已登录')].filter(Boolean).join(' · ')
      : tr(state.status === 'expired' ? '登录已失效' : state.status === 'unknown' ? '暂不可用' : '未登录')
  }
  async open(source: string) {
    const provider = this.providers.get(source)
    if (!provider || this.disabled) return
    this.cancel()
    this.revisions.set(source, (this.revisions.get(source) ?? 0) + 1)
    this.source = source
    this.scroll = document.scrollingElement?.scrollTop ?? 0
    el('settingsMain').hidden = true
    el('accountPage').hidden = false
    el('accountTitle').textContent = tr(provider.name)
    el('accountBack').focus()
    let state = this.states.get(source)
    const generation = this.generation
    this.render(state || { status: 'unknown' })
    if (!state || state.status === 'unknown') {
      this.busy(true); this.message('正在读取…')
      try { state = await call<AuthState>('get_provider_auth', { source }) }
      catch { state = { status: 'unknown' } }
      if (generation !== this.generation || this.source !== source) return
      this.states.set(source, state); this.renderRow(source)
    }
    this.render(state)
    this.busy(false)
    if (state.status !== 'signed-in' && state.status !== 'unknown') await this.start()
  }
  back(focus = true) {
    if (!this.source) return false
    const source = this.source
    this.cancel()
    this.source = ''
    el('accountPage').hidden = true
    el('settingsMain').hidden = false
    if (document.scrollingElement) document.scrollingElement.scrollTop = this.scroll
    if (focus) this.rows.get(source)?.button.focus({ preventScroll: true })
    return true
  }
  hide() {
    this.back(false)
    this.cancel()
    ++this.listing
    clearTimeout(this.refreshTimer)
    this.providers.clear(); this.rows.clear(); this.states.clear(); this.revisions.clear()
    el('accountRows').replaceChildren()
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
  private scanMessage() { this.message(this.source === 'bilibili'
    ? '请用哔哩哔哩 App 扫码并确认登录' : '请用片源对应的 App 扫码并确认登录') }
  render(state: AuthState) {
    const signedIn = state.status === 'signed-in'
    el('accountLogin').hidden = signedIn
    el('accountLogin').textContent = tr('扫码登录')
    el('accountLogout').hidden = !signedIn
    el('accountName').hidden = !signedIn || !state.name
    el('accountName').textContent = state.name || ''
    this.message(signedIn ? state.vip ? '已登录 · 大会员' : '已登录'
      : state.status === 'expired' ? '登录已失效，请重新扫码'
      : state.status === 'unknown' ? '登录状态暂时无法确认，请重试' : '未登录')
  }
  async refresh() {
    const listing = this.listing
    clearTimeout(this.refreshTimer)
    await Promise.all([...this.providers.keys()].map(async source => {
      // Never overwrite an in-flight or subsequently completed login/logout.
      if (source === this.source) return
      const revision = this.revisions.get(source)
      let state: AuthState
      try { state = await call<AuthState>('get_provider_auth', { source }) }
      catch { state = { status: 'unknown' } }
      if (listing !== this.listing || !this.providers.has(source) || source === this.source || revision !== this.revisions.get(source)) return
      this.states.set(source, state); this.renderRow(source)
    }))
    if (listing === this.listing && this.providers.size)
      this.refreshTimer = setTimeout(() => void this.refresh(), 15000)
  }
  async start() {
    if (!this.source) return
    this.cancel()
    const generation = this.generation, source = this.source
    this.render({ status: 'signed-out' })
    this.busy(true); this.message('正在生成登录二维码…')
    try {
      const state = await call<AuthState>('start_provider_login', { source })
      if (generation !== this.generation || source !== this.source) {
        if (state.loginId) void call('cancel_provider_login', { source, loginId: state.loginId }).catch(() => {})
        return
      }
      if (!state.loginId || !state.svg || !state.expiresAt) throw Error('登录暂时不可用，请重试')
      this.loginId = state.loginId
      el<HTMLImageElement>('accountQr').alt = tr('登录二维码')
      this.imageURL = URL.createObjectURL(new Blob([state.svg], { type: 'image/svg+xml' }))
      el<HTMLImageElement>('accountQr').src = this.imageURL
      el('accountQrArea').hidden = false
      el('accountCancel').hidden = false
      el('accountLogin').textContent = tr('刷新二维码')
      this.scanMessage()
      this.timer = setTimeout(() => void this.poll(generation, state.expiresAt!), 2000)
    } catch (error) { if (generation === this.generation) this.message(error instanceof Error ? error.message : '登录暂时不可用，请重试') }
    finally { if (generation === this.generation) this.busy(false) }
  }
  async poll(generation: number, expiresAt: number) {
    if (generation !== this.generation || !this.loginId) return
    if (Date.now() >= expiresAt) { this.cancel(); this.message('二维码已过期，请刷新后重试'); return }
    const source = this.source
    try {
      const state = await call<AuthState>('poll_provider_login', { source, loginId: this.loginId })
      if (generation !== this.generation) return
      if (state.status === 'signed-in') {
        this.cancel(); this.states.set(source, state); this.renderRow(source)
        this.back()
        await this.changed(source, true).catch(() => {})
        return
      }
      if (state.status === 'expired' || state.status === 'cancelled') {
        this.cancel(); this.message('二维码已过期，请刷新后重试'); return
      }
      if (state.status === 'scanned') this.message('已扫码，请在手机上确认')
      else this.scanMessage()
    } catch {
      if (generation !== this.generation) return
      this.message('登录请求暂时失败，正在重试…')
    }
    if (generation === this.generation) this.timer = setTimeout(() => void this.poll(generation, expiresAt), 2200)
  }
  async logout() {
    if (!this.source) return
    this.cancel()
    const generation = this.generation, source = this.source
    this.busy(true)
    try {
      const state = await call<AuthState>('logout_provider', { source })
      if (generation !== this.generation) return
      this.states.set(source, state); this.renderRow(source)
      this.back()
      await this.changed(source, false).catch(() => {})
    } catch { if (generation === this.generation) this.message('退出登录失败，请重试') }
    finally { if (generation === this.generation) this.busy(false) }
  }
}
