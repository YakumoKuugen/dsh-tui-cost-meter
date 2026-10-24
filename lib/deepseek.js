/**
 * DeepSeek cost + peak/off-peak projection.
 *
 * Pure: no filesystem, network, timers or React, so the ledger reader, the
 * poller and the tests can all share the same rules. The ledger itself is
 * written by dsh-cost-meter; this module only reads its public totals and
 * ignores every secret-bearing field.
 */

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const BEIJING_OFFSET_MS = 8 * HOUR_MS

/** Default peak windows (UTC hours, half-open) from the official price page. */
export const DEFAULT_PEAK_WINDOWS = Object.freeze([
  Object.freeze({ start: 1, end: 4 }),
  Object.freeze({ start: 6, end: 10 }),
])

/** Peak/off-peak pricing took effect at this instant. */
export const DEFAULT_PEAK_EFFECTIVE_AT = Date.parse('2026-08-01T00:00:00Z')

/** Weekend/holiday all-day off-peak pricing took effect at this instant. */
export const WEEKEND_OFFPEAK_EFFECTIVE_AT = Date.parse('2026-08-22T16:00:00Z')

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** Local calendar day key, matching dsh-cost-meter's day buckets. */
export function localDayKey(now = Date.now()) {
  const date = new Date(now)
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

/** Provider part of a `provider:model` ledger key, with the host `llm-` prefix stripped. */
export function providerOf(key) {
  if (typeof key !== 'string') return ''
  const separator = key.indexOf(':')
  let provider = (separator >= 0 ? key.slice(0, separator) : key).toLowerCase()
  if (provider.startsWith('llm-')) provider = provider.slice(4)
  return provider
}

/** Whether a ledger bucket belongs to a DeepSeek official channel. */
export function isDeepSeekProviderKey(key) {
  return /^deepseek(?:-official|-account)?$/.test(providerOf(key))
}

/** CNY per USD from the live cost-meter config, if known. */
export function cnyRateOf(config) {
  const direct = finiteNumber(config?.fxRates?.CNY)
  if (direct !== undefined && direct > 0) return direct
  const legacy = finiteNumber(config?.exchangeRate)
  return legacy !== undefined && legacy > 0 ? legacy : undefined
}

/**
 * Sum the DeepSeek buckets of one daily/total aggregate.
 *
 * `apiCost` is the real API spend; `cost` is the equivalent recorded cost for
 * older/plan rows. Frozen `*Cny` amounts win because they preserve the rate
 * used when the call was billed.
 *
 * @param {object|undefined} aggregate - day or total aggregate
 * @param {object|undefined} config - ledger config (for the CNY rate)
 * @returns {{cny?: number, usd?: number, calls: number}}
 */
export function sumDeepSeekCost(aggregate, config) {
  const buckets = isRecord(aggregate?.byProviderModel) ? aggregate.byProviderModel : {}
  const rate = cnyRateOf(config)
  let cny = 0
  let usd = 0
  let hasCny = false
  let hasUsd = false
  let calls = 0

  for (const [key, bucket] of Object.entries(buckets)) {
    if (!isDeepSeekProviderKey(key) || !isRecord(bucket)) continue
    const apiCost = finiteNumber(bucket.apiCost)
    const cost = finiteNumber(bucket.cost)
    const amountUsd = apiCost !== undefined && apiCost > 0
      ? apiCost
      : cost !== undefined
        ? cost
        : 0
    const frozenApi = finiteNumber(bucket.apiCostCny)
    const frozenCost = finiteNumber(bucket.costCny)
    if (frozenApi !== undefined || frozenCost !== undefined) {
      cny += frozenApi !== undefined ? frozenApi : frozenCost
      hasCny = true
    } else if (amountUsd > 0) {
      if (rate !== undefined) {
        cny += amountUsd * rate
        hasCny = true
      } else {
        usd += amountUsd
        hasUsd = true
      }
    }
    calls += finiteNumber(bucket.calls) ?? 0
  }

  if (hasUsd && rate !== undefined) {
    cny += usd * rate
    usd = 0
    hasUsd = false
    hasCny = true
  }

  return {
    ...(hasCny ? { cny } : {}),
    ...(hasUsd ? { usd } : {}),
    calls,
  }
}

function normalizeWindows(raw) {
  if (!Array.isArray(raw)) return DEFAULT_PEAK_WINDOWS.map(window => ({ ...window }))
  return raw
    .filter(window => isRecord(window))
    .map(window => ({ start: finiteNumber(window.start), end: finiteNumber(window.end) }))
    .filter(window => window.start !== undefined && window.end !== undefined
      && window.start >= 0 && window.start <= 24
      && window.end >= 0 && window.end <= 24
      && window.start !== window.end)
}

function normalizeHolidays(raw) {
  if (!Array.isArray(raw)) return []
  return raw.filter(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value))
}

/** Extract the peak schedule from a cost-meter ledger config. */
export function peakConfigOf(config) {
  const effectiveAt = Date.parse(config?.peakEffectiveAt ?? '')
  return {
    enabled: config?.peakEnabled !== false,
    windows: normalizeWindows(config?.peakWindows),
    holidays: normalizeHolidays(config?.peakHolidays),
    effectiveAtMs: Number.isFinite(effectiveAt) ? effectiveAt : DEFAULT_PEAK_EFFECTIVE_AT,
  }
}

function beijingDayIndex(atMs) {
  return Math.floor((atMs + BEIJING_OFFSET_MS) / DAY_MS)
}

function beijingDayKey(atMs) {
  return new Date(beijingDayIndex(atMs) * DAY_MS).toISOString().slice(0, 10)
}

function weekendAt(atMs) {
  if (!Number.isFinite(atMs) || atMs < WEEKEND_OFFPEAK_EFFECTIVE_AT) return false
  const weekday = (beijingDayIndex(atMs) + 4) % 7
  return weekday === 0 || weekday === 6
}

function holidayAt(atMs, holidays) {
  if (!Number.isFinite(atMs) || atMs < WEEKEND_OFFPEAK_EFFECTIVE_AT) return false
  return holidays.includes(beijingDayKey(atMs))
}

function isPeakAt(atMs, peak) {
  if (!Number.isFinite(atMs) || atMs < peak.effectiveAtMs) return false
  if (weekendAt(atMs) || holidayAt(atMs, peak.holidays)) return false
  const hour = new Date(atMs).getUTCHours()
  return peak.windows.some(window => {
    if (window.start < window.end) return hour >= window.start && hour < window.end
    // A window crossing UTC midnight is not used by the official page, but
    // tolerating it here keeps a hand-edited schedule predictable.
    return hour >= window.start || hour < window.end
  })
}

/** Compact countdown: `1h59m`, `45m`, `1d21h`. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0m'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return '<1m'
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const restMinutes = minutes % 60
  if (hours < 24) return restMinutes > 0 ? `${hours}h${restMinutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours > 0 ? `${days}d${restHours}h` : `${days}d`
}

/**
 * Resolve the current phase and the next price switch.
 *
 * @param {number} now - epoch ms
 * @param {object} peak - output of {@link peakConfigOf}
 * @returns {{
 *   inPeak: boolean, weekend: boolean, holiday: boolean,
 *   nextAtMs?: number, nextIntoPeak?: boolean,
 *   label: string, nextLabel?: string, countdown?: string, text: string
 * }|undefined}
 */
export function computePeakPhase(now, peak) {
  if (!Number.isFinite(now) || peak?.enabled !== true || !Array.isArray(peak.windows) || peak.windows.length === 0) {
    return undefined
  }
  if (now < peak.effectiveAtMs) return undefined

  const base = new Date(now)
  const candidates = new Set([peak.effectiveAtMs])
  for (let offset = -2; offset <= 14; offset += 1) {
    candidates.add(Date.UTC(
      base.getUTCFullYear(),
      base.getUTCMonth(),
      base.getUTCDate() + offset,
      16, 0, 0, 0,
    ))
    for (const window of peak.windows) {
      candidates.add(Date.UTC(
        base.getUTCFullYear(),
        base.getUTCMonth(),
        base.getUTCDate() + offset,
        window.start, 0, 0, 0,
      ))
      candidates.add(Date.UTC(
        base.getUTCFullYear(),
        base.getUTCMonth(),
        base.getUTCDate() + offset + (window.end <= window.start ? 1 : 0),
        window.end, 0, 0, 0,
      ))
    }
  }

  const sorted = [...candidates].filter(Number.isFinite).sort((left, right) => left - right)
  const points = []
  for (const at of sorted) {
    const before = isPeakAt(at - 1, peak)
    const after = isPeakAt(at, peak)
    if (before !== after) points.push({ at, intoPeak: after })
  }
  let previous
  let next
  for (const point of points) {
    if (point.at <= now) previous = point
    else {
      next = point
      break
    }
  }

  const inPeak = isPeakAt(now, peak)
  const nextIntoPeak = next === undefined ? undefined : next.intoPeak
  const label = inPeak ? '峰时' : '平价'
  const nextLabel = nextIntoPeak === undefined ? undefined : nextIntoPeak ? '峰时' : '平价'
  const countdown = next === undefined ? undefined : formatDuration(next.at - now)
  const progress = previous === undefined || next === undefined
    ? undefined
    : Math.max(0, Math.min(1, (now - previous.at) / (next.at - previous.at)))
  const weekend = weekendAt(now)
  const holiday = holidayAt(now, peak.holidays)

  return {
    inPeak,
    weekend,
    holiday,
    ...(previous === undefined ? {} : { prevAtMs: previous.at }),
    ...(next === undefined ? {} : { nextAtMs: next.at }),
    ...(nextIntoPeak === undefined ? {} : { nextIntoPeak }),
    ...(progress === undefined ? {} : { progress }),
    label,
    ...(nextLabel === undefined ? {} : { nextLabel }),
    ...(countdown === undefined ? {} : { countdown }),
    text: countdown === undefined ? label : `${label} · 距${nextLabel} ${countdown}`,
  }
}

/** Format a money amount in the currency returned by the source. */
export function formatMoney(amount, currency = 'CNY') {
  const number = finiteNumber(amount)
  if (number === undefined) return '—'
  const symbol = currency === 'USD' ? '$' : currency === 'EUR' ? '€' : '¥'
  return `${symbol}${number.toFixed(2)}`
}

function moneyOf(part, fallbackCurrency) {
  if (!isRecord(part)) return { amount: 0, currency: fallbackCurrency }
  if (finiteNumber(part.cny) !== undefined) return { amount: part.cny, currency: 'CNY' }
  if (finiteNumber(part.usd) !== undefined) return { amount: part.usd, currency: 'USD' }
  if (finiteNumber(part.total) !== undefined) {
    return { amount: part.total, currency: part.currency ?? fallbackCurrency }
  }
  return { amount: 0, currency: fallbackCurrency }
}

function moneyText(prefix, part, fallbackCurrency) {
  const money = moneyOf(part, fallbackCurrency)
  return `${prefix} ${formatMoney(money.amount, money.currency)}`
}

function amountOf(part) {
  return finiteNumber(part?.cny) ?? finiteNumber(part?.usd)
}

/**
 * Build the compact remaining/today/prior-used bar from the image-1 idea.
 *
 * The denominator is `balance + all recorded spend`, because that is the only
 * total the two sources give us. Today is carved out of the recorded spend so
 * the orange segment does not double-count in the gray one.
 *
 * @param {object} state - DeepSeekStore snapshot
 * @param {number} width - desired cells
 * @returns {{width: number, remaining: number, today: number, used: number}|undefined}
 */
export function buildCostBar(state, width) {
  const balance = state?.balance
  if (balance?.status !== 'ok') return undefined
  const month = state?.month ?? state?.total
  const balanceAmount = finiteNumber(balance.total)
  const totalAmount = amountOf(month)
  if (balanceAmount === undefined || totalAmount === undefined || balanceAmount < 0 || totalAmount < 0) return undefined
  const balanceCurrency = balance.currency ?? month?.currency ?? 'CNY'
  if (month?.currency !== undefined && month.currency !== balanceCurrency) return undefined
  const todayAmount = Math.min(totalAmount, Math.max(0, amountOf(state?.today) ?? 0))
  const denominator = balanceAmount + totalAmount
  if (!(denominator > 0)) return undefined

  const cells = Math.max(4, Math.min(30, Math.trunc(width) || 10))
  let remaining = Math.round(cells * balanceAmount / denominator)
  let today = Math.round(cells * todayAmount / denominator)
  if (balanceAmount > 0 && remaining === 0) remaining = 1
  if (todayAmount > 0 && today === 0) today = 1
  if (remaining > cells) remaining = cells
  if (remaining + today > cells) today = Math.max(0, cells - remaining)
  const used = Math.max(0, cells - remaining - today)
  if (remaining + today + used === 0) return undefined
  return { width: cells, remaining, today, used }
}

/** A tiny phase progress bar (`━━┃────`) used inside the peak segment. */
export function buildPeakBarText(peak, width = 8) {
  if (!Number.isFinite(peak?.progress) || !Number.isFinite(peak?.nextAtMs)) return undefined
  const cells = Math.max(4, Math.min(20, Math.trunc(width) || 8))
  const position = Math.max(0, Math.min(cells - 1, Math.round(peak.progress * (cells - 1))))
  return {
    text: `${'━'.repeat(position)}┃${'─'.repeat(cells - position - 1)}`,
    width: cells,
    position,
  }
}

// East Asian wide/fullwidth characters occupy two terminal cells. The
// status row must estimate cells, not UTF-16 code units, or an 80-column
// terminal wraps a Chinese label and hides the amount on the clipped line.
const WIDE_CHAR = /[\u1100-\u115F\u2329\u232A\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/u

/** Terminal cell width of a string (wide CJK/fullwidth = 2). */
export function cellWidth(text) {
  if (typeof text !== 'string') return 0
  let width = 0
  for (const char of text) width += WIDE_CHAR.test(char) ? 2 : 1
  return width
}

function estimateWidth(segments) {
  return segments.reduce((total, segment) => total + cellWidth(segment.text), 0)
    + Math.max(0, segments.length - 1) * 3
}

/**
 * Build the one-row DeepSeek view model.
 *
 * The peak countdown is kept even on narrow terminals; today/total are dropped
 * first because they are historical detail, while balance and the next price
 * switch are the actionable parts.
 *
 * @param {object} state - DeepSeekStore snapshot
 * @param {object} config - resolved plugin config
 * @param {{columns?: number, now?: number}} [options]
 * @returns {object|undefined}
 */
export function buildDeepSeekViewModel(state, config, options = {}) {
  if (config?.deepseekEnabled !== true) return undefined
  const phase = state?.phase
  if (phase === 'disabled') return undefined

  const columns = Number.isFinite(options.columns) ? Math.max(24, options.columns) : 80
  const label = 'DeepSeek'
  if (phase === 'idle') {
    return {
      kind: 'placeholder',
      label,
      segments: [{ text: '读取中…', dim: true }],
      refreshing: state?.refreshing === true,
    }
  }

  const month = state?.month ?? state?.total
  const today = state?.today
  const balance = state?.balance
  const peak = state?.peak
  const notice = state?.notice
  const fallbackCurrency = month?.currency ?? today?.currency ?? balance?.currency ?? 'CNY'

  const balanceSegment = config.deepseekShowBalance === true && balance !== undefined
    ? {
        text: balance.status === 'ok'
          ? moneyText('余额', balance, fallbackCurrency)
          : '余额 —',
        ...(balance.status === 'ok' ? { color: 'success' } : { dim: true }),
      }
    : undefined

  const monthSegment = config.deepseekShowTotal === true && month !== undefined
    ? { text: moneyText('本月', month, fallbackCurrency), dim: true }
    : undefined

  const todaySegment = config.deepseekShowToday === true && today !== undefined
    ? { text: moneyText('今日', today, fallbackCurrency), color: 'warning' }
    : undefined

  let peakRow
  let peakSegment
  if (config.deepseekShowPeak === true && peak !== undefined) {
    const peakBar = buildPeakBarText(peak, 8)
    const countdown = peak.nextLabel === undefined || peak.countdown === undefined
      ? undefined
      : `距${peak.nextLabel} ${peak.countdown}`
    if (peakBar !== undefined || countdown !== undefined) {
      peakRow = {
        label: typeof notice === 'string' && notice.length > 0 ? `已进入${notice}` : peak.label,
        color: (typeof notice === 'string' && notice.length > 0
          ? notice === '峰时'
          : peak.inPeak)
          ? 'warning'
          : 'success',
        ...(peakBar === undefined ? {} : { barText: peakBar.text }),
        ...(countdown === undefined ? {} : { countdown }),
      }
    } else {
      peakSegment = {
        text: peak.label,
        color: peak.inPeak ? 'warning' : 'success',
      }
    }
  }

  const extras = [monthSegment, todaySegment].filter(Boolean)
  const labelWidth = cellWidth(label) + 1
  const segments = []
  if (balanceSegment !== undefined) segments.push(balanceSegment)
  for (const extra of extras) {
    if (labelWidth + estimateWidth([...segments, extra, peakSegment].filter(Boolean)) <= columns - 2) {
      segments.push(extra)
    }
  }
  if (peakSegment !== undefined) segments.push(peakSegment)

  let bar = config.deepseekShowBar === true
    ? buildCostBar(state, config.deepseekBarWidth)
    : undefined
  if (bar !== undefined && labelWidth + estimateWidth(segments) + 1 + bar.width > columns - 2) {
    bar = undefined
  }

  if (segments.length === 0 && bar === undefined && peakRow === undefined) {
    if (phase === 'error') {
      return {
        kind: 'placeholder',
        label,
        segments: [{ text: '费用不可用', dim: true }],
        refreshing: state?.refreshing === true,
      }
    }
    return {
      kind: 'placeholder',
      label,
      segments: [{ text: '费用数据不可用', dim: true }],
      refreshing: state?.refreshing === true,
    }
  }

  return {
    kind: 'ready',
    label,
    segments,
    ...(bar === undefined ? {} : { bar }),
    ...(peakRow === undefined ? {} : { peakRow }),
    refreshing: state?.refreshing === true,
  }
}

/** Plain-text fallback for hosts without rich status views. */
export function formatDeepSeekStatusText(model) {
  if (model === undefined) return undefined
  const body = (model.segments ?? []).map(segment => segment.text).join(' · ')
  const bar = model.bar === undefined
    ? ''
    : ` ${'█'.repeat(model.bar.remaining + model.bar.today + model.bar.used)}`
  const peak = model.peakRow === undefined
    ? ''
    : ` | ${model.peakRow.label}${model.peakRow.barText === undefined ? '' : ` ${model.peakRow.barText}`}${model.peakRow.countdown === undefined ? '' : ` ${model.peakRow.countdown}`}`
  return `${model.label ?? 'DeepSeek'} ${body}${bar}${peak}${model.refreshing === true ? ' ⟳' : ''}`.trim().slice(0, 240)
}
