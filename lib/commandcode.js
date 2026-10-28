/**
 * CommandCode quota projection.
 *
 * Pure: no network, no filesystem, no React. The client hands over the
 * remaining percentages of the 5-hour and weekly windows plus the monthly
 * credits wallet; this module turns them into the compact one-row model the
 * host renders.
 *
 * The row mirrors the Codex row: a bar on the left, the remaining percentage
 * on the right, with the window label in front.
 */

import { buildBar, severityFor } from './quota.js'

const FIVE_HOURS = '5h'
const WEEK = '7d'

function clampPercent(value) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return undefined
  return Math.max(0, Math.min(100, number))
}

/**
 * Pick the window the row should show.
 *
 * @param {{fiveHourPercent?: number, weeklyPercent?: number, exceeded?: boolean}} quota
 * @param {'auto'|'fiveHour'|'weekly'} mode
 * @returns {{key: string, label: string, percent?: number, exceeded: boolean}|undefined}
 */
export function selectCommandCodeWindow(quota, mode = 'auto') {
  if (quota === undefined || quota === null) return undefined
  const fiveHour = quota.fiveHourPercent === undefined
    ? undefined
    : {
        key: FIVE_HOURS,
        label: FIVE_HOURS,
        percent: clampPercent(quota.fiveHourPercent),
        exceeded: quota.exceeded === true,
      }
  const weekly = quota.weeklyPercent === undefined
    ? undefined
    : {
        key: WEEK,
        label: WEEK,
        percent: clampPercent(quota.weeklyPercent),
        exceeded: quota.exceeded === true,
      }

  switch (mode) {
    case 'fiveHour':
      return fiveHour
    case 'weekly':
      return weekly
    case 'auto':
    default:
      return fiveHour ?? weekly
  }
}

/** Format the monthly credits wallet as `$10` / `$10.50`. */
export function formatCredits(credits) {
  const number = typeof credits === 'number' ? credits : Number(credits)
  if (!Number.isFinite(number) || number < 0) return undefined
  const rounded = Math.round(number * 100) / 100
  return `$${Number.isInteger(rounded) ? rounded : rounded.toFixed(2)}`
}

/** Format `remaining/granted` when the API reports the monthly grant. */
export function formatCreditsDetail(remaining, granted) {
  const left = formatCredits(remaining)
  if (left === undefined) return undefined
  const total = formatCredits(granted)
  if (total === undefined || granted === remaining) return left
  return `${left}/${total}`
}

/**
 * Build the CommandCode status-row model.
 *
 * @param {object} state - CommandCodeStore snapshot
 * @param {object} config - resolved plugin config
 * @param {{columns?: number}} [options]
 * @returns {object|undefined}
 */
export function buildCommandCodeViewModel(state, config, options = {}) {
  if (config?.commandcodeEnabled !== true) return undefined
  const phase = state?.phase
  if (phase === 'disabled') {
    if (state?.reason !== 'missing-key') return undefined
    return {
      kind: 'placeholder',
      label: 'CommandCode',
      placeholder: '未配置 API Key',
      refreshing: state?.refreshing === true,
    }
  }
  const label = 'CommandCode'
  if (phase === 'idle') {
    return { kind: 'placeholder', label, placeholder: '读取中…', refreshing: state?.refreshing === true }
  }
  if (phase === 'error') {
    return { kind: 'placeholder', label, placeholder: '额度不可用', refreshing: state?.refreshing === true }
  }

  const window = selectCommandCodeWindow(state?.quota, config.commandcodeWindow ?? 'auto')
  if (window === undefined) {
    return { kind: 'placeholder', label, placeholder: '无额度数据', refreshing: state?.refreshing === true }
  }

  const width = Math.max(4, Math.min(24, config.commandcodeBarWidth ?? 10))
  const percent = window.percent ?? 0
  const bar = buildBar(percent, width)
  const credits = config.commandcodeShowCredits === false
    ? undefined
    : formatCreditsDetail(state?.quota?.monthlyCredits, state?.quota?.monthlyCreditsGranted)
  const other = window.key === FIVE_HOURS
    ? state?.quota?.weeklyPercent
    : state?.quota?.fiveHourPercent
  const otherLabel = window.key === FIVE_HOURS ? WEEK : FIVE_HOURS
  return {
    kind: 'ready',
    label,
    windowLabel: window.label,
    unlimited: false,
    exceeded: window.exceeded === true || percent <= 0,
    filledText: bar.filledText,
    emptyText: bar.emptyText,
    percentText: `${Math.round(percent)}%`,
    otherLabel,
    otherPercentText: other === undefined ? undefined : `${Math.round(clampPercent(other) ?? 0)}%`,
    creditsText: credits,
    color: window.exceeded === true
      ? 'error'
      : severityFor(percent, config.commandcodeWarnAt ?? 30, config.commandcodeDangerAt ?? 10),
    refreshing: state?.refreshing === true,
  }
}

/** Plain-text fallback for hosts without rich status views. */
export function formatCommandCodeStatusText(model) {
  if (model === undefined) return undefined
  if (model.kind === 'placeholder') {
    return `${model.label ?? 'CommandCode'} ${model.placeholder ?? ''}`.trim().slice(0, 200)
  }
  const bar = `${model.filledText ?? ''}${model.emptyText ?? ''}`
  const other = model.otherPercentText === undefined ? '' : ` · ${model.otherLabel} ${model.otherPercentText}`
  const credits = model.creditsText === undefined ? '' : ` · ${model.creditsText}`
  return `${model.label ?? 'CommandCode'} ${model.windowLabel ?? ''} ${bar} ${model.percentText ?? ''}${other}${credits}`
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 200)
}
