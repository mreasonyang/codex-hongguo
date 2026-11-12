import type { Transform } from 'node:stream'
export type ErrorCode = 'ANONYMOUS_LIMITED' | 'RATE_LIMITED' | 'AUTHENTICATION_REQUIRED' | 'UNAUTHORIZED' |
  'CONTENT_UNAVAILABLE' | 'NOT_FOUND' | 'NO_VIDEO' | 'UNSUPPORTED_CODEC' | 'ABORTED' | 'TIMEOUT' | 'NETWORK' | 'HOST_NOT_ALLOWED' | 'CONTRACT' | 'MANIFEST' |
  'PROVIDER_ID' | 'LOAD_FAILED' | 'MEDIA_EXPIRED' | 'BUDGET' | 'OFFLINE' | 'MEDIA_FETCH' | 'MEDIA_FORMAT' | 'DECODE_FAILED' | 'RUNTIME_UNAVAILABLE'
export interface Manifest {
  apiVersion: 1
  id: string
  name: string
  version: string
  entry: string
  files?: string[]
  enabled?: boolean
  nsfw?: boolean
  discovery?: boolean
  progressivePlayback?: boolean
  recommendationTerms?: string[]
  queryMode?: 'search' | 'link'
  queryHint?: string
  emptyMessage?: string
  network?: { api?: string[], media?: string[] }
  authentication?: 'qrcode'
  contentTypes?: { id: string, name: string, queryHint?: string, emptyMessage?: string, categories?: { id: string, name: string }[] }[]
}
export interface RequestOptions { signal?: AbortSignal }
export interface ListOptions extends RequestOptions {
  query?: string
  cursor?: string
  pageSize?: number
  contentType?: string
  category?: string
}
export interface Series {
  id: string
  title: string
  description?: string
  coverURL?: string
  episodes?: number | null
  defaultEpisodeId?: string
  author?: string
  durationMs?: number
  contentType?: string
}
export interface Episode { id: string, number: number, label: string, playable?: boolean }
export interface Page<T> { items: T[], cursor?: string | null, series?: Series }
export interface Track { url: string, backupURLs?: string[], mime?: string, codecs?: string, initialization?: string, indexRange?: string }
export type Candidate = { kind: 'file' | 'dash' | 'hls', url: string, codec?: string, encryption?: { kind: 'cenc', key: string } } |
  { kind: 'tracks', video: Track, audio: Track, codec?: string, durationMs?: number }
export type MediaFetcher = (url: string, budget: number, timeout: number, redirects?: number,
  range?: { offset: number, length: number }, signal?: AbortSignal) =>
  Promise<{ body: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>, limit: Transform, url: string, totalBytes?: number }>
export interface Playback { candidates: Candidate[], fetchMedia?: MediaFetcher, durationMs?: number }
export type FetchOptions = RequestInit & { timeout?: number, budget?: number, followRedirects?: boolean }
export interface Context {
  apiVersion: 1
  id: string
  dataDir: string
  signal: AbortSignal
  fetch(url: string | URL, options?: FetchOptions): Promise<Response>
  fetchMedia: MediaFetcher
  mediaFetcher(headers: HeadersInit | ((url: URL) => HeadersInit)): MediaFetcher
}
type Result<T> = T | Promise<T>
export interface AccountState { status: string, name?: string, vip?: boolean, loginId?: string, svg?: string, expiresAt?: number }
export interface Provider {
  id: string
  discovery?: boolean
  recommendationTerms?: string[]
  progressivePlayback?: boolean
  auth?: {
    status(): Result<AccountState>
    start(owner: object): Result<AccountState>
    poll(owner: object, loginId: string): Result<AccountState>
    cancel(owner: object, loginId: string): Result<unknown>
    logout(): Result<unknown>
    revision?(): string
  }
  listSeries(options?: ListOptions): Result<Page<Series>>
  getSeries(id: string, options?: RequestOptions): Result<Series>
  listEpisodes(id: string, options?: ListOptions): Result<Page<Episode>>
  getCover(id: string, options?: RequestOptions & {url?: string}): Result<{bytes: Uint8Array, mime?: string} | null>
  resolvePlayback(id: string, options?: RequestOptions): Result<Playback>
  dispose?(): Result<void>
}
export type CreateProvider = (context: Context) => Result<Provider>
export const providerPattern: RegExp
export const errorCodes: readonly ErrorCode[]
export function providerError(code: ErrorCode): Error & {code: ErrorCode}
export function validateManifest(value: unknown): Manifest
export function validateResult<K extends 'listSeries'|'getSeries'|'listEpisodes'|'getCover'|'resolvePlayback'>(method: K, value: unknown): Awaited<ReturnType<Provider[K]>>
export function relativeFile(value: unknown, suffix?: string): boolean
export function page<T>(items: T[], cursor?: string | null): Page<T>
export function cover(bytes: Uint8Array, mime?: string): { bytes: Uint8Array, mime?: string }
export function filePlayback(url: string, codec?: string): Playback
export function fetchJSON<T = unknown>(context: Context, url: string | URL, options?: FetchOptions): Promise<T>
