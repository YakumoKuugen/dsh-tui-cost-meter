import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildBar,
  buildStatusViewModel,
  clampPercent,
  formatReset,
  formatStatusText,
  formatWindowLabel,
  selectQuotaWindow,
  severityFor,
} from '../lib/quota.js'

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0)

const USAGE = {
  rateLimits: [
    {
      id: 'codex',
      name: 'Codex',
      windows: [
        { remainingPercent: 63, windowSeconds: 18_000, resetAt: Math.floor(NOW / 1000) + 2 * 3600 + 13 * 60 },
        { remainingPercent: 42, windowSeconds: 604_800, resetAt: Math.floor(NOW / 1000) + 3 * 86400 },
      ],
    },
  ],
}

const CONFIG = {
  enabled: true,
  window: 'auto',
  barWidth: 10,
  showLabel: true,
  showReset: false,
  showUnavailable: true,
  warnAt: 30,
  dangerAt: 10,
}

test('selects the 5-hour window by default and by explicit mode', () => {
  const auto = selectQuotaWindow(USAGE, 'auto')
  assert.equal(auto?.windowSeconds, 18_000)
  assert.equal(auto?.remainingPercent, 63)
  assert.equal(auto?.label, '5h')

  assert.equal(selectQuotaWindow(USAGE, 'fiveHour')?.windowSeconds, 18_000)
  assert.equal(selectQuotaWindow(USAGE, 'weekly')?.windowSeconds, 604_800)
  assert.equal(selectQuotaWindow(USAGE, 'shortest')?.windowSeconds, 18_000)
  assert.equal(selectQuotaWindow(USAGE, 'longest')?.windowSeconds, 604_800)
})

test('falls back to the only window when the requested one is absent', () => {
  const weeklyOnly = {
    rateLimits: [{
      id: 'codex',
      windows: [{ remainingPercent: 100, windowSeconds: 604_800, resetAt: Math.floor(NOW / 1000) + 86400 }],
    }],
  }
  assert.equal(selectQuotaWindow(weeklyOnly, 'fiveHour')?.windowSeconds, 604_800)
  assert.equal(selectQuotaWindow(weeklyOnly, 'auto')?.label, '7d')
})

test('prefers the codex bucket over additional buckets', () => {
  const usage = {
    rateLimits: [
      { id: 'code_review', windows: [{ remainingPercent: 10, windowSeconds: 604_800 }] },
      { id: 'codex', windows: [{ remainingPercent: 80, windowSeconds: 18_000 }] },
    ],
  }
  assert.equal(selectQuotaWindow(usage, 'auto')?.limitId, 'codex')
  assert.equal(selectQuotaWindow(usage, 'auto')?.remainingPercent, 80)
})

test('returns undefined for empty or malformed usage', () => {
  assert.equal(selectQuotaWindow(undefined, 'auto'), undefined)
  assert.equal(selectQuotaWindow({}, 'auto'), undefined)
  assert.equal(selectQuotaWindow({ rateLimits: [] }, 'auto'), undefined)
  assert.equal(selectQuotaWindow({ rateLimits: [{ id: 'codex', windows: [] }] }, 'auto'), undefined)
})

test('formats window labels compactly', () => {
  assert.equal(formatWindowLabel(18_000), '5h')
  assert.equal(formatWindowLabel(604_800), '7d')
  assert.equal(formatWindowLabel(3_600), '1h')
  assert.equal(formatWindowLabel(5_400), '90m')
  assert.equal(formatWindowLabel(300), '5m')
  assert.equal(formatWindowLabel(0), 'window')
})

test('formats the reset countdown', () => {
  assert.equal(formatReset(Math.floor(NOW / 1000) + 2 * 3600 + 13 * 60, NOW), '2h13m')
  assert.equal(formatReset(Math.floor(NOW / 1000) + 3 * 86400 + 4 * 3600, NOW), '3d4h')
  assert.equal(formatReset(Math.floor(NOW / 1000) - 1, NOW), '已重置')
  assert.equal(formatReset(undefined, NOW), undefined)
  assert.equal(formatReset(Number.NaN, NOW), undefined)
})

test('builds a two-tone bar with clamped edges', () => {
  assert.deepEqual(buildBar(63, 10), {
    filled: 6,
    empty: 4,
    filledText: '██████',
    emptyText: '░░░░',
  })
  assert.equal(buildBar(0, 5).filledText, '')
  assert.equal(buildBar(0, 5).emptyText, '░░░░░')
  assert.equal(buildBar(100, 5).filledText, '█████')
  assert.equal(buildBar(100, 5).emptyText, '')
  assert.equal(buildBar(150, 4).filled, 4)
  assert.equal(buildBar(-10, 4).filled, 0)
})

test('clamps percentages and normalizes reversed color thresholds', () => {
  assert.equal(clampPercent(150), 100)
  assert.equal(clampPercent(-1), 0)
  assert.equal(clampPercent(Number.NaN), 0)
  assert.equal(severityFor(50, 30, 10), 'success')
  assert.equal(severityFor(20, 30, 10), 'warning')
  assert.equal(severityFor(10, 30, 10), 'error')
  // Reversed: the lower number still wins as the danger line.
  assert.equal(severityFor(10, 10, 30), 'error')
  assert.equal(severityFor(20, 10, 30), 'warning')
  assert.equal(severityFor(40, 10, 30), 'success')
})

test('projects a ready view model', () => {
  const model = buildStatusViewModel(
    { phase: 'ready', usage: USAGE, refreshing: false },
    CONFIG,
    { now: NOW, columns: 80 },
  )
  assert.equal(model?.kind, 'ready')
  assert.equal(model?.label, 'Codex 5h')
  assert.equal(model?.filledText, '██████')
  assert.equal(model?.emptyText, '░░░░')
  assert.equal(model?.percentText, '63%')
  assert.equal(model?.color, 'success')
  assert.equal(model?.resetText, undefined)
})

test('shows the reset countdown when enabled', () => {
  const model = buildStatusViewModel(
    { phase: 'ready', usage: USAGE, refreshing: true },
    { ...CONFIG, showReset: true },
    { now: NOW, columns: 80 },
  )
  assert.equal(model?.resetText, '2h13m')
  assert.equal(model?.refreshing, true)
})

test('shrinks the bar to fit narrow terminals', () => {
  const model = buildStatusViewModel(
    { phase: 'ready', usage: USAGE },
    { ...CONFIG, barWidth: 40 },
    { now: NOW, columns: 30 },
  )
  assert.equal((model?.filledText.length ?? 0) + (model?.emptyText.length ?? 0), 15)
})

test('renders nothing when disabled or when placeholders are off', () => {
  assert.equal(buildStatusViewModel({ phase: 'ready', usage: USAGE }, { ...CONFIG, enabled: false }), undefined)
  assert.equal(
    buildStatusViewModel({ phase: 'signed-out' }, { ...CONFIG, showUnavailable: false }),
    undefined,
  )
})

test('renders placeholders for signed-out, auth-pending, expired, error and empty states', () => {
  assert.equal(buildStatusViewModel({ phase: 'signed-out' }, CONFIG)?.placeholder, '未登录 · /login')
  assert.equal(buildStatusViewModel({ phase: 'auth-pending' }, CONFIG)?.placeholder, '正在确认登录…')
  assert.equal(buildStatusViewModel({ phase: 'expired' }, CONFIG)?.placeholder, '登录已过期 · /login')
  assert.equal(buildStatusViewModel({ phase: 'error' }, CONFIG)?.placeholder, '额度不可用')
  assert.equal(buildStatusViewModel({ phase: 'ready' }, CONFIG)?.placeholder, '无额度数据')
  assert.equal(buildStatusViewModel({ phase: 'idle' }, CONFIG)?.placeholder, '读取中…')
})

test('keeps the last bar during an auth retry and marks it as checking', () => {
  const model = buildStatusViewModel(
    { phase: 'auth-pending', usage: USAGE },
    CONFIG,
    { now: NOW, columns: 80 },
  )
  assert.equal(model?.kind, 'ready')
  assert.equal(model?.checking, true)
  assert.equal(model?.stale, false)
  assert.equal(model?.percentText, '63%')
})

test('formats the text fallback', () => {
  assert.equal(
    formatStatusText({
      kind: 'ready',
      label: 'Codex 5h',
      filledText: '██████',
      emptyText: '░░░░',
      percentText: '63%',
      resetText: '2h13m',
      stale: false,
    }),
    'Codex 5h ██████░░░░ 63% · 2h13m',
  )
  assert.equal(
    formatStatusText({ kind: 'placeholder', label: 'Codex', placeholder: '未登录 · /login' }),
    'Codex 未登录 · /login',
  )
  assert.equal(formatStatusText(undefined), undefined)
})
