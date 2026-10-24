/**
 * Pure quota projection: pick one Codex window, turn it into a compact bar and
 * a percentage. This module deliberately has no I/O, timers, Cordis or React,
 * so both the status view and the tests can call it directly.
 */

const FIVE_HOURS = 5 * 60 * 60
const SEVEN_DAYS = 7 * 24 * 60 * 60
const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const FILLED = '█'
const EMPTY = '░'

/** Clamp a percentage into 0..100 without letting NaN through. */
export function clampPercent(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(100, number))
}

/**
 * Human label for a server-declared rolling window.
 *
 * @param {number} seconds - window length in seconds
 * @returns {string} compact label (`5h`, `7d`, `90m`, …)
 */
export function formatWindowLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return 'window'
  if (seconds === FIVE_HOURS) return '5h'
  if (seconds === SEVEN_DAYS) return '7d'
  if (seconds % DAY === 0) return `${seconds / DAY}d`
  if (seconds % HOUR === 0) return `${seconds / HOUR}h`
  if (seconds % MINUTE === 0) return `${seconds / MINUTE}m`
  return `${Math.max(1, Math.round(seconds / MINUTE))}m`
}

/**
 * Render the remaining time until a reset as a compact duration.
 *
 * @param {number|undefined} resetAt - Unix seconds reported by the server
 * @param {number} [now] - wall clock in milliseconds (injectable for tests)
 * @returns {string|undefined} `2h13m`, `4d3h`, `已重置`, or undefined
 */
export function formatReset(resetAt, now = Date.now()) {
  if (typeof resetAt !== 'number' || !Number.isFinite(resetAt) || resetAt <= 0) return undefined
  const remainingMs = resetAt * 1000 - now
  if (remainingMs <= 0) return '已重置'
  const totalMinutes = Math.ceil(remainingMs / 60000)
  const days = Math.floor(totalMinutes / (24 * 60))
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60)
  const minutes = totalMinutes % 60
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`
  if (hours > 0) return minutes > 0 ? `${hours}h${minutes}m` : `${hours}h`
  return `${Math.max(1, minutes)}m`
}

/**
 * Build a two-tone progress bar of a fixed cell width.
 *
 * @param {number} percent - remaining percentage
 * @param {number} width - bar width in cells
 * @returns {{filled: number, empty: number, filledText: string, emptyText: string}}
 */
export function buildBar(percent, width) {
  const cells = Math.max(1, Math.trunc(width) || 1)
  const ratio = clampPercent(percent) / 100
  const filled = Math.max(0, Math.min(cells, Math.round(cells * ratio)))
  return {
    filled,
    empty: cells - filled,
    filledText: FILLED.repeat(filled),
    emptyText: EMPTY.repeat(cells - filled),
  }
}

/**
 * Theme color for a remaining percentage.
 *
 * Thresholds are normalized: whichever value is lower counts as the danger
 * line, so an accidentally reversed pair can never hide a red state.
 *
 * @param {number} percent - remaining percentage
 * @param {number} warnAt - amber threshold
 * @param {number} dangerAt - red threshold
 * @returns {'success'|'warning'|'error'}
 */
export function severityFor(percent, warnAt, dangerAt) {
  const value = clampPercent(percent)
  const first = clampPercent(warnAt)
  const second = clampPercent(dangerAt)
  const danger = Math.min(first, second)
  const warn = Math.max(first, second)
  if (value <= danger) return 'error'
  if (value <= warn) return 'warning'
  return 'success'
}

/**
 * Choose the Codex rate-limit window the user asked for.
 *
 * The primary `codex` bucket wins over additional buckets. Window labels are
 * derived from the server's own `limit_window_seconds`, never from field
 * position: the server currently reports only a weekly primary window, while
 * other plans report 5h + weekly pairs.
 *
 * @param {object|undefined} usage - parsed usage projection
 * @param {string} mode - one of the plugin's window modes
 * @returns {{
 *   remainingPercent: number, windowSeconds: number, resetAt?: number,
 *   label: string, limitId: string, limitName?: string
 * }|undefined}
 */
export function selectQuotaWindow(usage, mode = 'auto') {
  if (usage === null || typeof usage !== 'object' || !Array.isArray(usage.rateLimits)) return undefined
  const limits = usage.rateLimits.filter(limit =>
    limit !== null && typeof limit === 'object' && Array.isArray(limit.windows)
  )
  if (limits.length === 0) return undefined
  const limit = limits.find(entry => entry.id === 'codex') ?? limits[0]
  const windows = limit.windows.filter(window =>
    window !== null && typeof window === 'object'
    && typeof window.remainingPercent === 'number'
    && Number.isFinite(window.remainingPercent)
  )
  if (windows.length === 0) return undefined

  const pick = (predicate, fallbackMode) => {
    const matches = windows.filter(predicate)
    if (matches.length > 0) return matches[0]
    return selectByMode(windows, fallbackMode)
  }

  let window
  switch (mode) {
    case 'fiveHour':
      window = pick(value => value.windowSeconds >= 4 * HOUR && value.windowSeconds <= 6 * HOUR, 'shortest')
      break
    case 'weekly':
      window = pick(value => value.windowSeconds >= 6 * DAY && value.windowSeconds <= 8 * DAY, 'longest')
      break
    case 'shortest':
      window = selectByMode(windows, 'shortest')
      break
    case 'longest':
      window = selectByMode(windows, 'longest')
      break
    case 'auto':
    default:
      // Prefer the short rolling window (the one a coding session exhausts
      // first), then fall back to whatever the plan exposes.
      window = windows.find(value => value.windowSeconds >= 4 * HOUR && value.windowSeconds <= 6 * HOUR)
        ?? selectByMode(windows, 'shortest')
      break
  }

  return {
    remainingPercent: clampPercent(window.remainingPercent),
    windowSeconds: window.windowSeconds,
    ...(typeof window.resetAt === 'number' && window.resetAt > 0 ? { resetAt: window.resetAt } : {}),
    label: formatWindowLabel(window.windowSeconds),
    limitId: typeof limit.id === 'string' ? limit.id : 'codex',
    ...(typeof limit.name === 'string' && limit.name.length > 0 ? { limitName: limit.name } : {}),
  }
}

function selectByMode(windows, mode) {
  const sorted = [...windows].sort((left, right) =>
    (left.windowSeconds ?? 0) - (right.windowSeconds ?? 0)
  )
  return mode === 'longest' ? sorted[sorted.length - 1] : sorted[0]
}

/**
 * Project the poller state + live settings into the status-line model.
 *
 * Returning `undefined` means "draw nothing": the caller can pass it straight
 * to the view and render null.
 *
 * @param {object} state - quota store snapshot
 * @param {object} config - resolved display config
 * @param {{now?: number, columns?: number}} [options]
 * @returns {object|undefined}
 */
export function buildStatusViewModel(state, config, options = {}) {
  if (config === undefined || config.enabled !== true) return undefined
  const now = options.now ?? Date.now()
  const columns = Number.isFinite(options.columns) ? Math.max(20, options.columns) : 80

  const selected = selectQuotaWindow(state?.usage, config.window)
  if (selected !== undefined) {
    const percent = clampPercent(selected.remainingPercent)
    const label = config.showLabel ? `Codex ${selected.label}` : undefined
    const resetText = config.showReset ? formatReset(selected.resetAt, now) : undefined
    const reserved = (label === undefined ? 0 : label.length + 1)
      + 6
      + (resetText === undefined ? 0 : resetText.length + 3)
    const width = Math.max(4, Math.min(config.barWidth, columns - reserved))
    const bar = buildBar(percent, width)
    return {
      kind: 'ready',
      label,
      filledText: bar.filledText,
      emptyText: bar.emptyText,
      percentText: `${Math.round(percent)}%`,
      ...(resetText === undefined ? {} : { resetText }),
      color: severityFor(percent, config.warnAt, config.dangerAt),
      stale: state?.phase === 'error',
      checking: state?.phase === 'auth-pending',
      refreshing: state?.refreshing === true,
    }
  }

  if (config.showUnavailable !== true) return undefined
  const phase = state?.phase
  const placeholder = phase === 'signed-out'
    ? '未登录 · /login'
    : phase === 'auth-pending'
      ? '正在确认登录…'
      : phase === 'expired'
        ? '登录已过期 · /login'
        : phase === 'error'
        ? '额度不可用'
        : phase === 'ready'
          ? '无额度数据'
          : '读取中…'
  return {
    kind: 'placeholder',
    label: 'Codex',
    placeholder,
    refreshing: state?.refreshing === true,
  }
}

/**
 * Plain-text fallback used when a host refuses rich status views.
 *
 * @param {object} model - output of {@link buildStatusViewModel}
 * @returns {string|undefined}
 */
export function formatStatusText(model) {
  if (model === undefined) return undefined
  if (model.kind === 'placeholder') {
    return `${model.label ?? 'Codex'} ${model.placeholder}`.slice(0, 200)
  }
  const label = model.label === undefined ? '' : `${model.label} `
  const reset = model.resetText === undefined ? '' : ` · ${model.resetText}`
  const stale = model.stale === true ? ' !' : ''
  return `${label}${model.filledText}${model.emptyText} ${model.percentText}${reset}${stale}`.slice(0, 200)
}
