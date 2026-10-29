/**
 * CommandCode quota state and its refresh loop.
 *
 * Same shape as the other stores: a tiny external store plus a poller that
 * owns every timer. The poller is inert while the row is disabled, so a
 * profile without a CommandCode key never issues a request.
 */

import { fetchCommandCodeQuota, resolveCommandCodeApiKeys } from './commandcode-client.js'

const DEFAULT_REFRESH_SECONDS = 300
const MIN_REFRESH_SECONDS = 30
const MANUAL_GAP_MS = 5_000
/** A failed read is retried quickly: the cause is usually a rotated key. */
const ERROR_RETRY_MS = 30_000

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Minimal stable external store. */
export class CommandCodeStore {
  constructor(initial = {}) {
    this.snapshot = {
      phase: 'idle',
      quota: undefined,
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

  set(patch) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.notify()
  }

  notify() {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A rendering subscriber must never break the poller.
      }
    }
  }
}

export class CommandCodePoller {
  constructor(options) {
    this.store = options.store
    this.getConfig = options.getConfig
    // `resolveApiKeys` returns every plausible key so a rotated one cannot pin
    // the row to an auth error; `resolveApiKey` stays supported for callers
    // that only have one.
    this.resolveApiKeys = options.resolveApiKeys
      ?? (options.resolveApiKey === undefined
        ? (async () => [])
        : async () => {
            const single = await options.resolveApiKey()
            return single === undefined ? [] : [single]
          })
    this.fetchQuota = options.fetchQuota ?? fetchCommandCodeQuota
    this.logger = options.logger
    this.now = options.now ?? (() => Date.now())
    this.timer = undefined
    this.inflight = undefined
    this.stopped = true
    this.generation = 0
    this.lastFetch = 0
    this.lastManualRefresh = 0
    this.retryAt = undefined
    this.keySource = undefined
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.generation += 1
    this.timer = setInterval(() => this.tick(), 30_000)
    this.timer.unref?.()
    void this.tick(true)
  }

  stop() {
    this.stopped = true
    this.generation += 1
    this.inflight = undefined
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  /** A live settings change repaints and refetches right away. */
  trigger() {
    if (this.stopped) return
    this.store.notify()
    void this.tick(true)
  }

  /** Click on the row: force a refresh (5s throttle). */
  refreshManually() {
    if (this.stopped) return undefined
    const now = this.now()
    if (now - this.lastManualRefresh < MANUAL_GAP_MS) return undefined
    this.lastManualRefresh = now
    return this.refresh(true)
  }

  refreshSecondsOf(config) {
    const value = Number(config?.commandcodeRefreshSeconds)
    if (!Number.isFinite(value)) return DEFAULT_REFRESH_SECONDS
    return Math.max(MIN_REFRESH_SECONDS, Math.min(3600, Math.trunc(value)))
  }

  tick(force = false) {
    if (this.stopped) return
    const config = this.getConfig()
    if (config.commandcodeEnabled !== true) {
      this.store.set({ phase: 'disabled', reason: 'feature-off', refreshing: false })
      return
    }
    const now = this.now()
    const due = now - this.lastFetch >= this.refreshSecondsOf(config) * 1000
    const retrying = this.retryAt !== undefined && now >= this.retryAt
    if (force || due || retrying) {
      void this.refresh(force)
    }
  }

  refresh(force = false) {
    if (this.stopped) return Promise.resolve(undefined)
    if (this.inflight !== undefined) return this.inflight
    const config = this.getConfig()
    if (config.commandcodeEnabled !== true) return Promise.resolve(undefined)
    const generation = this.generation
    const task = this.run(config, force, generation).finally(() => {
      if (this.inflight === task) this.inflight = undefined
    })
    this.inflight = task
    return task
  }

  async run(config, force, generation) {
    const now = this.now()
    this.store.set({ refreshing: true })
    try {
      const candidates = await this.candidates()
      if (candidates.length === 0) {
        this.store.set({
          phase: 'disabled',
          reason: 'missing-key',
          error: undefined,
          updatedAt: now,
          refreshing: false,
        })
        return
      }

      let last = undefined
      for (const candidate of candidates) {
        const result = await this.fetchQuota(candidate, { now })
        if (this.stopped || generation !== this.generation) return
        if (result?.status === 'ok') {
          this.keySource = candidate.source
          this.retryAt = undefined
          this.lastFetch = now
          this.store.set({
            phase: 'ready',
            quota: {
              fiveHourPercent: result.fiveHourPercent,
              weeklyPercent: result.weeklyPercent,
              fiveHourResetsAt: result.fiveHourResetsAt,
              weeklyResetsAt: result.weeklyResetsAt,
              monthlyCredits: result.monthlyCredits,
              monthlyCreditsGranted: result.monthlyCreditsGranted,
              limited: result.limited === true,
              exceeded: result.exceeded === true,
            },
            error: undefined,
            errorCode: undefined,
            keySource: candidate.source,
            updatedAt: now,
            refreshing: false,
          })
          return
        }
        last = result
        if (result?.status === 'missing') continue
        // Only a rejected key is worth retrying with the next candidate; a
        // network or parse failure would fail the same way for every key.
        if (result?.code !== 'auth') break
      }

      const message = isRecord(last) ? last.message : undefined
      if (last?.status === 'missing') {
        this.store.set({
          phase: 'disabled',
          reason: 'missing-key',
          error: undefined,
          updatedAt: now,
          refreshing: false,
        })
        return
      }
      this.retryAt = now + ERROR_RETRY_MS
      this.store.set({
        phase: 'error',
        error: typeof message === 'string' ? message : 'CommandCode 额度查询失败',
        errorCode: isRecord(last) && typeof last.code === 'string' ? last.code : undefined,
        updatedAt: now,
        refreshing: false,
      })
      if (typeof message === 'string') this.logger?.warn?.(`[cost-meter] ${message}`)
    } catch (error) {
      if (this.stopped || generation !== this.generation) return
      const text = error instanceof Error ? error.message : String(error)
      this.retryAt = now + ERROR_RETRY_MS
      this.store.set({
        phase: 'error',
        error: `CommandCode 额度查询失败: ${text}`.slice(0, 200),
        errorCode: 'network',
        updatedAt: now,
        refreshing: false,
      })
      this.logger?.warn?.(`[cost-meter] CommandCode 额度查询失败: ${text}`)
    }
  }

  /** Candidates with the source that last worked moved to the front. */
  async candidates() {
    let keys
    try {
      keys = await this.resolveApiKeys()
    } catch {
      return []
    }
    if (!Array.isArray(keys)) return []
    const good = keys.find(key => key?.source === this.keySource)
    if (good === undefined) return keys
    return [good, ...keys.filter(key => key !== good)]
  }
}

/** Convenience factory used by the plugin entry point. */
export function createCommandCodePoller(options) {
  return new CommandCodePoller({
    ...options,
    resolveApiKeys: options.resolveApiKeys ?? ((ctx, env) => resolveCommandCodeApiKeys(ctx, env)),
  })
}
