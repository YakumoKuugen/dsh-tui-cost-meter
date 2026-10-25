/**
 * MiniMax quota state and its refresh loop.
 *
 * Same shape as the Codex store: a tiny external store plus a poller that owns
 * every timer. The poller is inert while the MiniMax line is disabled, so a
 * profile without a MiniMax key never issues a request.
 */

import { fetchMiniMaxQuota, resolveMiniMaxApiKey } from './minimax-client.js'

const DEFAULT_REFRESH_SECONDS = 300
const MIN_REFRESH_SECONDS = 30
const MANUAL_GAP_MS = 5_000

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Minimal stable external store. */
export class MiniMaxStore {
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

export class MiniMaxPoller {
  constructor(options) {
    this.store = options.store
    this.getConfig = options.getConfig
    this.resolveApiKey = options.resolveApiKey ?? (async () => undefined)
    this.fetchQuota = options.fetchQuota ?? fetchMiniMaxQuota
    this.getModel = options.getModel ?? (() => undefined)
    this.logger = options.logger
    this.now = options.now ?? (() => Date.now())
    this.timer = undefined
    this.inflight = undefined
    this.stopped = true
    this.generation = 0
    this.lastFetch = 0
    this.lastManualRefresh = 0
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
    const value = Number(config?.minimaxRefreshSeconds)
    if (!Number.isFinite(value)) return DEFAULT_REFRESH_SECONDS
    return Math.max(MIN_REFRESH_SECONDS, Math.min(3600, Math.trunc(value)))
  }

  tick(force = false) {
    if (this.stopped) return
    const config = this.getConfig()
    if (config.minimaxEnabled !== true) {
      this.store.set({ phase: 'disabled', refreshing: false })
      return
    }
    const now = this.now()
    if (force || now - this.lastFetch >= this.refreshSecondsOf(config) * 1000) {
      void this.refresh(force)
    }
  }

  refresh(force = false) {
    if (this.stopped) return Promise.resolve(undefined)
    if (this.inflight !== undefined) return this.inflight
    // A poller that has not started yet has no timer; an explicit refresh
    // still works, so the store is written even before `start()`.
    const config = this.getConfig()
    if (config.minimaxEnabled !== true) return Promise.resolve(undefined)
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
      const credential = await this.resolveApiKey()
      const result = await this.fetchQuota(credential, {
        now,
        model: this.getModel(),
      })
      if (this.stopped || generation !== this.generation) return
      if (result?.status === 'ok') {
        this.lastFetch = now
        this.store.set({
          phase: 'ready',
          quota: {
            intervalPercent: result.intervalPercent,
            weeklyPercent: result.weeklyPercent,
            intervalUnlimited: result.intervalUnlimited === true,
            weeklyUnlimited: result.weeklyUnlimited === true,
            model: result.model,
          },
          error: undefined,
          updatedAt: now,
          refreshing: false,
        })
        return
      }
      const message = isRecord(result) ? result.message : undefined
      if (result?.status === 'missing') {
        this.store.set({
          phase: 'disabled',
          error: undefined,
          updatedAt: now,
          refreshing: false,
        })
        return
      }
      this.lastFetch = now
      this.store.set({
        phase: 'error',
        error: typeof message === 'string' ? message : 'MiniMax 额度查询失败',
        updatedAt: now,
        refreshing: false,
      })
      if (typeof message === 'string') this.logger?.warn?.(`[cost-meter] ${message}`)
    } catch (error) {
      if (this.stopped || generation !== this.generation) return
      const text = error instanceof Error ? error.message : String(error)
      this.lastFetch = now
      this.store.set({
        phase: 'error',
        error: `MiniMax 额度查询失败: ${text}`.slice(0, 200),
        updatedAt: now,
        refreshing: false,
      })
      this.logger?.warn?.(`[cost-meter] MiniMax 额度查询失败: ${text}`)
    }
  }
}

/** Convenience factory used by the plugin entry point. */
export function createMiniMaxPoller(options) {
  return new MiniMaxPoller({
    ...options,
    resolveApiKey: options.resolveApiKey ?? ((ctx, env) => resolveMiniMaxApiKey(ctx, env)),
  })
}
