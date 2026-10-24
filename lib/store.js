/**
 * Live quota state + refresh loop.
 *
 * The store is a tiny external store so the host's React can subscribe with
 * `useSyncExternalStore` without the plugin importing React. The poller owns
 * every timer and every network promise; stopping it leaves nothing running.
 */

import { CodexAuthError } from './usage-client.js'
import { readBestCredential } from './credentials.js'

const MIN_REFRESH_SECONDS = 15
const MANUAL_REFRESH_GAP_MS = 5_000
const TOKEN_PATTERN = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu

/** Redact anything token-shaped before it reaches a log or the status line. */
export function safeErrorText(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(TOKEN_PATTERN, '[redacted token]').slice(0, 300)
}

function isAuthError(error) {
  if (error instanceof CodexAuthError) return true
  if (error !== null && typeof error === 'object') {
    const code = error.code
    if (code === 'OPENAI_CODEX_REAUTH_REQUIRED' || code === 'CODEX_AUTH_EXPIRED') return true
  }
  // A bare HTTP 403 is not proof of an expired login: Cloudflare, a rate
  // limit, or an account policy can all answer 403 while the OAuth session is
  // healthy. Only 401 (and provider-specific reauth codes above) count.
  return /not signed in|signed out|reauth|authorization must be renewed|HTTP 401\b/iu
    .test(safeErrorText(error))
}

/** Minimal stable external store. */
export class QuotaStore {
  constructor(initial = {}) {
    this.snapshot = {
      phase: 'idle',
      usage: undefined,
      error: undefined,
      updatedAt: 0,
      refreshing: false,
      ...initial,
    }
    this.listeners = new Set()
    this.subscribe = listener => {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    }
    this.getSnapshot = () => this.snapshot
  }

  /** Merge a patch and notify subscribers. */
  set(patch) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.notify()
  }

  /** Notify without changing data (used for live settings re-renders). */
  notify() {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A render subscriber must never break the poller or other subscribers.
      }
    }
  }
}

/**
 * Poll Codex quota and publish it into a {@link QuotaStore}.
 *
 * The dsh-codex service is preferred when it is signed in because it owns the
 * OAuth refresh and proxy transport. Otherwise the plugin reads the same
 * credential documents dsh-tui's native Codex backend uses.
 */
export class QuotaPoller {
  constructor(options) {
    this.store = options.store
    this.getConfig = options.getConfig
    this.getService = options.getService ?? (() => undefined)
    this.readCredential = options.readCredential ?? readBestCredential
    this.fetchUsage = options.fetchUsage
    this.logger = options.logger
    this.now = options.now ?? (() => Date.now())
    this.minRefreshSeconds = options.minRefreshSeconds ?? MIN_REFRESH_SECONDS
    this.authFailureThreshold = options.authFailureThreshold ?? 3
    this.authRetryMs = options.authRetryMs ?? 5_000
    this.authFailures = 0
    this.timer = undefined
    this.inflight = undefined
    this.stopped = true
    this.generation = 0
    this.lastManualRefresh = 0
  }

  start() {
    if (!this.stopped) return this.inflight
    this.stopped = false
    this.authFailures = 0
    this.generation += 1
    return this.poll()
  }

  stop() {
    this.stopped = true
    this.generation += 1
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /** Ask for an immediate refresh; repeated clicks inside 5s are ignored. */
  refreshManually() {
    if (this.stopped) return undefined
    const now = this.now()
    if (now - this.lastManualRefresh < MANUAL_REFRESH_GAP_MS) return undefined
    this.lastManualRefresh = now
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
    return this.poll(true)
  }

  /** Re-read the interval after a live settings change. */
  reschedule(delayMs) {
    this.schedule(delayMs)
  }

  /** Refresh now unless a request is already in flight. */
  trigger() {
    if (this.stopped || this.inflight !== undefined) return
    this.schedule(0)
  }

  /**
   * Fetch once. Concurrent callers share the in-flight promise, so a button
   * click and a timer tick cannot double-hit the endpoint.
   *
   * @param {boolean} [force] - bypass the provider's 15s cache
   */
  poll(force = false) {
    if (this.stopped) return Promise.resolve(undefined)
    if (this.inflight !== undefined) return this.inflight
    const generation = this.generation
    const task = this.run(force, generation).finally(() => {
      if (this.inflight === task) this.inflight = undefined
    })
    this.inflight = task
    return task
  }

  schedule(delayMs) {
    if (this.stopped) return
    if (this.timer !== undefined) clearTimeout(this.timer)
    let delay = delayMs
    if (delay === undefined) {
      const config = this.getConfig()
      const seconds = config.enabled ? config.refreshSeconds : MIN_REFRESH_SECONDS
      delay = Math.max(this.minRefreshSeconds, seconds) * 1000
    }
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.poll()
    }, delay)
    this.timer.unref?.()
  }

  async run(force, generation) {
    const config = this.getConfig()
    if (!config.enabled) {
      this.authFailures = 0
      this.store.set({ phase: 'disabled', refreshing: false })
      this.schedule()
      return
    }

    this.store.set({ refreshing: true })
    // A cold proxy/DNS can fail the very first request while the TUI boots;
    // retry non-auth failures once quickly instead of showing "unavailable"
    // for a full interval.
    let retryDelayMs
    try {
      const usage = await this.readUsage(force)
      if (this.stopped || generation !== this.generation) return
      this.authFailures = 0
      this.store.set({
        phase: 'ready',
        usage,
        error: undefined,
        updatedAt: this.now(),
        refreshing: false,
      })
    } catch (error) {
      if (this.stopped || generation !== this.generation) return
      const text = safeErrorText(error)
      const code = error !== null && typeof error === 'object' ? error.code : undefined
      const auth = isAuthError(error)
      const previous = this.store.getSnapshot()
      const signedOut = code === 'CODEX_SIGNED_OUT'
      if (signedOut) this.authFailures = 0
      else if (auth) this.authFailures += 1
      else this.authFailures = 0
      const authPending = auth && !signedOut && this.authFailures < this.authFailureThreshold
      const phase = signedOut
        ? 'signed-out'
        : authPending
          ? 'auth-pending'
          : auth
            ? 'expired'
            : 'error'
      if (authPending) retryDelayMs = this.authRetryMs
      else if (auth) retryDelayMs = 30_000
      else retryDelayMs = 15_000
      this.store.set({
        phase,
        // One transient 401 (a credential refresh race, a proxy hiccup) is not
        // a logout. Keep the last reading while we retry, and only drop it
        // after repeated rejections prove the session is really gone.
        usage: auth && !authPending ? undefined : previous.usage,
        error: text,
        updatedAt: this.now(),
        refreshing: false,
      })
      this.logger?.warn?.(`[codex-quota] ${text}`)
    } finally {
      this.schedule(retryDelayMs)
    }
  }

  async readUsage(force) {
    let service
    try {
      service = this.getService()
    } catch {
      service = undefined
    }

    if (service !== undefined && typeof service.authStatus === 'function' && typeof service.usage === 'function') {
      let authenticated = false
      try {
        const status = await service.authStatus()
        authenticated = status?.authenticated === true
      } catch {
        authenticated = false
      }
      if (authenticated) {
        try {
          return await service.usage(force === true)
        } catch (error) {
          // A rejected service token may still have a newer copy in dsh-auth
          // (the native Codex backend refreshes it independently). Only fall
          // through for auth errors; a network error is reported as-is.
          if (!isAuthError(error)) throw error
        }
      }
    }

    const credential = await this.readCredential()
    if (credential === undefined) {
      const error = new CodexAuthError('Codex is not signed in')
      error.code = 'CODEX_SIGNED_OUT'
      throw error
    }
    // `expired` only describes the short-lived access token. The refresh
    // token can still be valid, and dsh-tui may be rotating the file right
    // now, so let the endpoint decide instead of pre-emptively claiming the
    // login is dead.
    return await this.fetchUsage(credential)
  }
}
