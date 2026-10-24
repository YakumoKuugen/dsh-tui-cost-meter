/**
 * Live DeepSeek cost/balance state and the peak/off-peak clock.
 *
 * The clock ticks every 30s so the countdown and the switch toast do not
 * depend on the (much slower) balance/ledger refresh. Network and filesystem
 * work is coalesced, and stopping the poller leaves no timer behind.
 */

import { computePeakPhase, peakConfigOf } from './deepseek.js'
import { fetchDeepSeekBalance, readCostMeterLedger } from './deepseek-client.js'

const DEFAULT_REFRESH_SECONDS = 300
const MIN_REFRESH_SECONDS = 30
const TICK_MS = 5_000
const NOTICE_MS = 60_000
const MANUAL_GAP_MS = 5_000

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function errorText(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.slice(0, 300)
}

/** Bound one source so one hung network call cannot freeze the whole row. */
function withTimeout(promise, ms, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms)
    timer.unref?.()
  })
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

/** Minimal stable external store, same contract as the Codex quota store. */
export class DeepSeekStore {
  constructor(initial = {}) {
    this.snapshot = {
      phase: 'idle',
      month: undefined,
      total: undefined,
      today: undefined,
      balance: undefined,
      peak: undefined,
      notice: undefined,
      error: undefined,
      updatedAt: 0,
      refreshing: false,
      now: Date.now(),
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
        // A rendering subscriber must never break the clock or the fetch.
      }
    }
  }
}

export class DeepSeekPoller {
  constructor(options) {
    this.store = options.store
    this.getConfig = options.getConfig
    this.readLedger = options.readLedger ?? readCostMeterLedger
    this.resolveApiKey = options.resolveApiKey ?? (async () => undefined)
    this.readAccountBalance = options.readAccountBalance ?? (async () => undefined)
    this.readPlatformUsage = options.readPlatformUsage ?? (async () => undefined)
    this.fetchBalance = options.fetchBalance ?? fetchDeepSeekBalance
    this.notify = options.notify
    this.logger = options.logger
    this.now = options.now ?? (() => Date.now())
    this.tickMs = options.tickMs ?? TICK_MS
    this.peakConfig = peakConfigOf({})
    this.lastPeakKey = JSON.stringify(this.peakConfig)
    this.lastPhase = undefined
    this.dataReady = false
    this.notice = undefined
    this.lastFetch = 0
    this.lastManualRefresh = 0
    this.timer = undefined
    this.inflight = undefined
    this.stopped = true
    this.generation = 0
    this.data = undefined
    this.balance = undefined
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.generation += 1
    this.tick()
    this.timer = setInterval(() => this.tick(), this.tickMs)
    this.timer.unref?.()
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

  /** React to a live settings edit: repaint and fetch with the new policy. */
  trigger() {
    if (this.stopped) return
    this.store.notify()
    this.tick(true)
  }

  /** Click on the row: force a balance + ledger refresh (5s throttle). */
  refreshManually() {
    if (this.stopped) return undefined
    const now = this.now()
    if (now - this.lastManualRefresh < MANUAL_GAP_MS) return undefined
    this.lastManualRefresh = now
    return this.refresh(true)
  }

  refreshSecondsOf(config) {
    const value = Number(config?.deepseekRefreshSeconds)
    if (!Number.isFinite(value)) return DEFAULT_REFRESH_SECONDS
    return Math.max(MIN_REFRESH_SECONDS, Math.min(3600, Math.trunc(value)))
  }

  tick(force = false) {
    if (this.stopped) return
    const config = this.getConfig()
    const now = this.now()

    if (config.deepseekEnabled !== true) {
      this.lastPhase = undefined
      this.dataReady = false
      this.notice = undefined
      this.store.set({ phase: 'disabled', refreshing: false, notice: undefined, now })
      return
    }

    const peak = config.deepseekShowPeak === true
      ? computePeakPhase(now, this.peakConfig)
      : undefined

    const peakKey = JSON.stringify(this.peakConfig)
    const configChanged = peakKey !== this.lastPeakKey
    if (configChanged) {
      this.lastPeakKey = peakKey
      this.lastPhase = peak
    }

    if (peak !== undefined && this.lastPhase !== undefined && this.dataReady
      && !configChanged && peak.inPeak !== this.lastPhase.inPeak) {
      const label = peak.inPeak ? '峰时' : '平价'
      this.notice = { label, until: now + NOTICE_MS }
      if (config.deepseekPeakNotify !== false && typeof this.notify === 'function') {
        try {
          this.notify(
            peak.inPeak
              ? 'DeepSeek 已进入峰时 · API 价格较高'
              : 'DeepSeek 已进入平价时段 · 价格较低',
            peak.inPeak ? 'warning' : 'success',
          )
        } catch {
          // A host toast failure must not break the clock.
        }
      }
    }
    this.lastPhase = peak

    let notice
    if (this.notice !== undefined) {
      if (this.notice.until > now) notice = this.notice.label
      else this.notice = undefined
    }

    this.store.set({ now, peak, notice })

    if (force || now - this.lastFetch >= this.refreshSecondsOf(config) * 1000) {
      void this.refresh(force)
    }
  }

  refresh(force = false) {
    if (this.stopped) return Promise.resolve(undefined)
    if (this.inflight !== undefined) return this.inflight
    const config = this.getConfig()
    if (config.deepseekEnabled !== true) return Promise.resolve(undefined)

    const generation = this.generation
    const task = this.run(config, force, generation).finally(() => {
      if (this.inflight === task) this.inflight = undefined
    })
    this.inflight = task
    return task
  }

  applyPlatformUsage(usage) {
    if (!isRecord(usage) || usage.status !== 'ok') return
    const money = amount => usage.currency === 'USD'
      ? { usd: amount, currency: 'USD' }
      : { cny: amount, currency: usage.currency ?? 'CNY' }
    this.data = {
      ...(this.data ?? { peakConfig: this.peakConfig, present: false }),
      month: money(usage.month),
      today: money(usage.today),
      currency: usage.currency,
      usageSource: 'platform',
    }
  }

  publish(now, peak, error) {
    if (error !== undefined) {
      if (this.lastLoggedError !== error) {
        this.logger?.warn?.(`[codex-quota] ${error}`)
        this.lastLoggedError = error
      }
    } else {
      this.lastLoggedError = undefined
    }
    const hasData = this.data !== undefined
    const hasBalance = this.balance?.status === 'ok'
    if (hasData || hasBalance) {
      this.store.set({
        phase: 'ready',
        month: this.data?.month,
        total: this.data?.total,
        today: this.data?.today,
        currency: this.data?.currency ?? this.balance?.currency ?? 'CNY',
        usageSource: this.data?.usageSource,
        balance: this.balance,
        peak,
        error,
        updatedAt: now,
        refreshing: false,
        now,
      })
      return
    }
    this.store.set({
      phase: 'error',
      balance: this.balance,
      peak,
      error: error ?? 'DeepSeek 费用数据不可用',
      updatedAt: now,
      refreshing: false,
      now,
    })
  }

  async run(config, force, generation) {
    const now = this.now()
    this.store.set({ refreshing: true })
    let error

    // Stage 1: the ledger is local and fast. Publish it before any network
    // call so the row never sits at "读取中…" while the platform/balance
    // requests are slow or blocked by a signed-out account.
    const [ledgerResult] = await Promise.allSettled([
      withTimeout(this.readLedger(), 5_000, 'ledger'),
    ])
    if (this.stopped || generation !== this.generation) return
    if (ledgerResult.status === 'fulfilled' && isRecord(ledgerResult.value)) {
      this.data = ledgerResult.value
      if (ledgerResult.value.peakConfig !== undefined) this.peakConfig = ledgerResult.value.peakConfig
    } else if (ledgerResult.status === 'rejected') {
      error = `费用账本读取失败: ${errorText(ledgerResult.reason)}`
    }

    let peak = config.deepseekShowPeak === true
      ? computePeakPhase(now, this.peakConfig)
      : undefined
    if (!this.dataReady && (this.data !== undefined || this.balance?.status === 'ok')) {
      this.dataReady = true
      this.lastPhase = peak
    }
    this.publish(now, peak, error)

    // Stage 2: independent network sources, each with its own timeout. The
    // platform month replaces the ledger's current-month fallback when it
    // arrives; the 5s clock repaints even if this update races startup.
    const balancePromise = config.deepseekShowBalance === true
      ? this.readBalance(now)
      : Promise.resolve({ status: 'off', fetchedAt: now })
    const [balanceResult, usageResult] = await Promise.allSettled([
      withTimeout(balancePromise, 12_000, 'balance'),
      withTimeout(this.readPlatformUsage(), 8_000, 'platform usage'),
    ])
    if (this.stopped || generation !== this.generation) return

    if (balanceResult.status === 'fulfilled' && isRecord(balanceResult.value)) {
      this.balance = balanceResult.value
      if (balanceResult.value.status === 'error' && error === undefined) {
        error = `余额读取失败: ${balanceResult.value.message ?? 'unknown'}`
      }
    } else if (balanceResult.status === 'rejected' && error === undefined) {
      error = `余额读取失败: ${errorText(balanceResult.reason)}`
    }
    if (usageResult.status === 'fulfilled') this.applyPlatformUsage(usageResult.value)

    peak = config.deepseekShowPeak === true
      ? computePeakPhase(now, this.peakConfig)
      : undefined
    if (!this.dataReady && (this.data !== undefined || this.balance?.status === 'ok')) {
      this.dataReady = true
      this.lastPhase = peak
    }
    this.publish(now, peak, error)
    this.lastFetch = now
  }

  async readBalance(now) {
    let account
    try {
      account = await withTimeout(this.readAccountBalance(now), 2_000, 'account balance')
    } catch {
      account = undefined
    }
    if (account?.status === 'ok') return account

    const key = await this.resolveApiKey()
    if (key === undefined || typeof key.value !== 'string' || key.value.length === 0) {
      return account ?? { status: 'missing', message: '未配置 DeepSeek API Key', fetchedAt: now }
    }
    const api = await this.fetchBalance(key.value, { now })
    if (api?.status === 'ok' || account === undefined) return api
    // Both sources failed: prefer the API's clearer unauthorized state, but
    // keep the account's missing state when the key simply is not present.
    return api.status === 'missing' ? account : api
  }
}
