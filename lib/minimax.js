/**
 * MiniMax Token Plan quota projection.
 *
 * Pure: no network, no filesystem, no React. The quota client hands over the
 * remaining percentages of the current 5-hour window and the current week;
 * this module turns them into the compact status-row model the host renders.
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
 * @param {{intervalPercent?: number, weeklyPercent?: number, intervalUnlimited?: boolean, weeklyUnlimited?: boolean}} quota
 * @param {'auto'|'interval'|'weekly'} mode
 * @returns {{key: string, label: string, percent?: number, unlimited: boolean}|undefined}
 */
export function selectMiniMaxWindow(quota, mode = 'auto') {
  if (quota === undefined || quota === null) return undefined
  const interval = quota.intervalUnlimited === true
    ? { key: FIVE_HOURS, label: FIVE_HOURS, unlimited: true }
    : quota.intervalPercent === undefined
      ? undefined
      : { key: FIVE_HOURS, label: FIVE_HOURS, percent: clampPercent(quota.intervalPercent), unlimited: false }
  const weekly = quota.weeklyUnlimited === true
    ? { key: WEEK, label: WEEK, unlimited: true }
    : quota.weeklyPercent === undefined
      ? undefined
      : { key: WEEK, label: WEEK, percent: clampPercent(quota.weeklyPercent), unlimited: false }

  switch (mode) {
    case 'interval':
      return interval
    case 'weekly':
      return weekly
    case 'auto':
    default:
      return interval ?? weekly
  }
}

/**
 * Build the MiniMax status-row model.
 *
 * @param {object} state - MiniMaxStore snapshot
 * @param {object} config - resolved plugin config
 * @param {{columns?: number}} [options]
 * @returns {object|undefined}
 */
export function buildMiniMaxViewModel(state, config, options = {}) {
  if (config?.minimaxEnabled !== true) return undefined
  const phase = state?.phase
  // The feature switch turns the row off entirely; a missing key keeps a
  // quiet placeholder so an active MiniMax session is not left blank.
  if (phase === 'disabled') {
    if (state?.reason !== 'missing-key') return undefined
    return {
      kind: 'placeholder',
      label: 'MiniMax',
      placeholder: '未配置 API Key',
      refreshing: state?.refreshing === true,
    }
  }

  const label = 'MiniMax'
  if (phase === 'idle') {
    return { kind: 'placeholder', label, placeholder: '读取中…', refreshing: state?.refreshing === true }
  }
  if (phase === 'error') {
    return { kind: 'placeholder', label, placeholder: '额度不可用', refreshing: state?.refreshing === true }
  }

  const window = selectMiniMaxWindow(state?.quota, config.minimaxWindow ?? 'auto')
  if (window === undefined) {
    return { kind: 'placeholder', label, placeholder: '无额度数据', refreshing: state?.refreshing === true }
  }

  const width = Math.max(4, Math.min(24, config.minimaxBarWidth ?? 10))
  if (window.unlimited) {
    return {
      kind: 'ready',
      label,
      windowLabel: window.label,
      unlimited: true,
      filledText: '∞',
      emptyText: '',
      percentText: '不限',
      color: 'success',
      refreshing: state?.refreshing === true,
    }
  }

  const percent = window.percent ?? 0
  const bar = buildBar(percent, width)
  return {
    kind: 'ready',
    label,
    windowLabel: window.label,
    unlimited: false,
    filledText: bar.filledText,
    emptyText: bar.emptyText,
    percentText: `${Math.round(percent)}%`,
    color: severityFor(percent, config.minimaxWarnAt ?? 30, config.minimaxDangerAt ?? 10),
    refreshing: state?.refreshing === true,
  }
}

/** Plain-text fallback for hosts without rich status views. */
export function formatMiniMaxStatusText(model) {
  if (model === undefined) return undefined
  if (model.kind === 'placeholder') {
    return `${model.label ?? 'MiniMax'} ${model.placeholder ?? ''}`.trim().slice(0, 200)
  }
  const bar = model.unlimited === true
    ? '∞'
    : `${model.filledText ?? ''}${model.emptyText ?? ''}`
  return `${model.label ?? 'MiniMax'} ${model.windowLabel ?? ''} ${bar} ${model.percentText ?? ''}`
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 200)
}
