import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS } from '../lib/config.js'
import {
  DEFAULT_PEAK_EFFECTIVE_AT,
  DEFAULT_PEAK_WINDOWS,
  buildCostBar,
  buildDeepSeekViewModel,
  buildPeakBarText,
  cellWidth,
  computePeakPhase,
  formatDeepSeekStatusText,
  formatDuration,
  formatMoney,
  isDeepSeekProviderKey,
  localDayKey,
  peakConfigOf,
  sumDeepSeekCost,
} from '../lib/deepseek.js'
import { projectCostMeterLedger } from '../lib/deepseek-client.js'

const NOW = Date.UTC(2026, 9, 24, 4, 31) // Saturday 12:31 Beijing
const CONFIG = {
  ...DEFAULTS,
  deepseekEnabled: true,
  deepseekShowBalance: true,
  deepseekShowToday: true,
  deepseekShowTotal: true,
  deepseekShowPeak: true,
  deepseekPeakNotify: true,
  deepseekRefreshSeconds: 300,
}

const PEAK = {
  enabled: true,
  windows: DEFAULT_PEAK_WINDOWS.map(window => ({ ...window })),
  holidays: [],
  effectiveAtMs: DEFAULT_PEAK_EFFECTIVE_AT,
}

test('sums only DeepSeek official-channel buckets and prefers frozen CNY', () => {
  const aggregate = {
    byProviderModel: {
      'deepseek-official:deepseek-flash': { apiCost: 1, cost: 1, apiCostCny: 7, costCny: 7, calls: 2 },
      'deepseek-account:deepseek-flash': { apiCost: 2, cost: 2, costCny: 14, calls: 1 },
      'llm-deepseek:deepseek-pro': { cost: 0.5, costCny: 3.5, calls: 1 },
      'openai-codex:gpt-6': { apiCost: 100, cost: 100, costCny: 700, calls: 1 },
      'deepseek:deepseek-chat': { cost: 0.25, calls: 1 },
    },
  }
  assert.equal(isDeepSeekProviderKey('deepseek-official:deepseek-flash'), true)
  assert.equal(isDeepSeekProviderKey('llm-deepseek:deepseek-pro'), true)
  assert.equal(isDeepSeekProviderKey('openai-codex:gpt-6'), false)
  assert.deepEqual(sumDeepSeekCost(aggregate, { fxRates: { CNY: 7 } }), {
    cny: 24.5 + 1.75,
    calls: 5,
  })
})

test('converts unfrozen USD buckets with the ledger rate', () => {
  const aggregate = { byProviderModel: { 'deepseek-official:flash': { cost: 2, calls: 1 } } }
  assert.deepEqual(sumDeepSeekCost(aggregate, { fxRates: { CNY: 7.2 } }), { cny: 14.4, calls: 1 })
  assert.deepEqual(sumDeepSeekCost(aggregate, {}), { usd: 2, calls: 1 })
})

test('projects today and all retained days from a ledger document', () => {
  const todayKey = localDayKey(NOW)
  const doc = {
    config: {
      currency: 'CNY',
      fxRates: { CNY: 7 },
      peakEnabled: true,
      peakWindows: [{ start: 1, end: 4 }, { start: 6, end: 10 }],
      peakEffectiveAt: '2026-08-01T00:00:00Z',
      peakHolidays: ['2026-10-01'],
    },
    days: {
      [todayKey]: {
        byProviderModel: {
          'deepseek-official:flash': { cost: 1, costCny: 7, calls: 2 },
          'openai-codex:gpt-6': { cost: 100, costCny: 700, calls: 1 },
        },
      },
      '2026-10-23': {
        byProviderModel: {
          'deepseek-account:flash': { cost: 2, costCny: 14, calls: 3 },
        },
      },
    },
  }
  const projected = projectCostMeterLedger(doc, NOW)
  assert.equal(projected.total.cny, 21)
  assert.equal(projected.month.cny, 21)
  assert.equal(projected.total.calls, 5)
  assert.equal(projected.today.cny, 7)
  assert.equal(projected.today.calls, 2)
  assert.equal(projected.peakConfig.windows.length, 2)
  assert.deepEqual(projected.peakConfig.holidays, ['2026-10-01'])
})

test('computes the weekday peak phase and countdown', () => {
  const fridayPeak = Date.UTC(2026, 9, 23, 7, 0) // 15:00 Beijing
  const during = computePeakPhase(fridayPeak, PEAK)
  assert.equal(during?.inPeak, true)
  assert.equal(during?.label, '峰时')
  assert.equal(during?.nextLabel, '平价')
  assert.equal(during?.countdown, '3h')
  assert.equal(during?.text, '峰时 · 距平价 3h')

  const fridayOff = Date.UTC(2026, 9, 23, 4, 0) // 12:00 Beijing
  const off = computePeakPhase(fridayOff, PEAK)
  assert.equal(off?.inPeak, false)
  assert.equal(off?.label, '平价')
  assert.equal(off?.nextLabel, '峰时')
  assert.equal(off?.countdown, '2h')
})

test('weekends and holidays are all off-peak', () => {
  const saturday = computePeakPhase(NOW, PEAK)
  assert.equal(saturday?.inPeak, false)
  assert.equal(saturday?.weekend, true)
  assert.equal(saturday?.holiday, false)
  // Saturday 12:31 → Monday 09:00 Beijing = 44h29m.
  assert.equal(saturday?.countdown, '1d20h')

  const holidayPeak = { ...PEAK, holidays: ['2026-10-01'] }
  const holiday = computePeakPhase(Date.UTC(2026, 9, 1, 4, 0), holidayPeak)
  assert.equal(holiday?.inPeak, false)
  assert.equal(holiday?.holiday, true)
})

test('disables peak output before the effective date and when turned off', () => {
  assert.equal(computePeakPhase(Date.UTC(2026, 6, 1, 4, 0), PEAK), undefined)
  assert.equal(computePeakPhase(NOW, { ...PEAK, enabled: false }), undefined)
  assert.equal(computePeakPhase(NOW, { ...PEAK, windows: [] }), undefined)
})

test('formats money and countdowns', () => {
  assert.equal(formatMoney(86.5, 'CNY'), '¥86.50')
  assert.equal(formatMoney(1.2, 'USD'), '$1.20')
  assert.equal(formatMoney(undefined), '—')
  assert.equal(formatDuration(2 * 3600 * 1000 - 60 * 1000), '1h59m')
  assert.equal(formatDuration(45 * 3600 * 1000), '1d21h')
  assert.equal(formatDuration(45_000), '<1m')
  assert.equal(formatDuration(0), '0m')
})

test('builds a remaining/today/prior-used bar without double counting today', () => {
  const bar = buildCostBar({
    balance: { status: 'ok', currency: 'CNY', total: 60.5 },
    total: { cny: 67.78, currency: 'CNY' },
    today: { cny: 2.88, currency: 'CNY' },
  }, 10)
  assert.equal(bar?.width, 10)
  assert.equal(bar?.remaining + bar?.today + bar?.used, 10)
  assert.ok((bar?.remaining ?? 0) >= 1)
  assert.ok((bar?.today ?? 0) >= 1)
  assert.equal(buildCostBar({ balance: { status: 'missing' } }, 10), undefined)
})

test('builds a peak progress bar with the marker at the current phase', () => {
  const bar = buildPeakBarText({ progress: 0.5, nextAtMs: Date.now() + 3600_000 }, 8)
  assert.equal(bar?.text.length, 8)
  assert.equal(bar?.text.includes('┃'), true)
  assert.equal(bar?.position, 4)
  assert.equal(buildPeakBarText({}, 8), undefined)
})

test('uses state.month instead of the retained total when present', () => {
  const model = buildDeepSeekViewModel({
    phase: 'ready',
    total: { cny: 999, currency: 'CNY' },
    month: { cny: 128.99, currency: 'CNY' },
    today: { cny: 5.5, currency: 'CNY' },
    balance: { status: 'ok', currency: 'CNY', total: 60.5 },
    peak: undefined,
    refreshing: false,
  }, CONFIG, { columns: 80 })
  assert.deepEqual(model?.segments.map(segment => segment.text), ['余额 ¥60.50', '本月 ¥128.99', '今日 ¥5.50'])
})

test('builds the ready row with balance, total, today and peak', () => {
  const state = {
    phase: 'ready',
    total: { cny: 77.26, currency: 'CNY' },
    today: { cny: 12.37, currency: 'CNY' },
    balance: { status: 'ok', currency: 'CNY', total: 86.5 },
    peak: { inPeak: true, label: '峰时', nextLabel: '平价', countdown: '1h59m', text: '峰时 · 距平价 1h59m' },
    notice: undefined,
    refreshing: false,
  }
  const model = buildDeepSeekViewModel(state, CONFIG, { columns: 80 })
  assert.equal(model?.kind, 'ready')
  assert.deepEqual(model?.segments.map(segment => segment.text), [
    '余额 ¥86.50',
    '本月 ¥77.26',
    '今日 ¥12.37',
  ])
  assert.equal(model?.peakRow.label, '峰时')
  assert.equal(model?.peakRow.color, 'warning')
  assert.equal(model?.peakRow.countdown, '距平价 1h59m')
  assert.equal(formatDeepSeekStatusText(model), 'DeepSeek 余额 ¥86.50 · 本月 ¥77.26 · 今日 ¥12.37 ██████████ | 峰时 距平价 1h59m')
  assert.equal(model?.bar.width, 10)
  assert.equal(model?.bar.remaining + model?.bar.today + model?.bar.used, 10)
  assert.equal(cellWidth('余额'), 4)
  assert.equal(cellWidth('DeepSeek'), 8)
})

test('keeps balance and peak on narrow terminals and drops history first', () => {
  const state = {
    phase: 'ready',
    total: { cny: 77.26, currency: 'CNY' },
    today: { cny: 12.37, currency: 'CNY' },
    balance: { status: 'ok', currency: 'CNY', total: 86.5 },
    peak: { inPeak: false, label: '平价', nextLabel: '峰时', countdown: '1h29m', text: '平价 · 距峰时 1h29m' },
    refreshing: false,
  }
  const model = buildDeepSeekViewModel(state, CONFIG, { columns: 40 })
  assert.deepEqual(model?.segments.map(segment => segment.text), [
    '余额 ¥86.50',
    '本月 ¥77.26',
  ])
  assert.equal(model?.bar, undefined)
  assert.equal(model?.peakRow.label, '平价')
  assert.equal(model?.peakRow.countdown, '距峰时 1h29m')
})

test('shows dashes/placeholders instead of failing when sources are missing', () => {
  const missingBalance = buildDeepSeekViewModel({
    phase: 'ready',
    total: { cny: 0, currency: 'CNY' },
    today: { cny: 0, currency: 'CNY' },
    balance: { status: 'missing' },
    peak: undefined,
    refreshing: false,
  }, CONFIG, { columns: 80 })
  assert.equal(missingBalance?.segments[0].text, '余额 —')
  assert.equal(missingBalance?.segments[0].dim, true)

  assert.equal(buildDeepSeekViewModel({ phase: 'idle' }, CONFIG)?.segments[0].text, '读取中…')
  assert.equal(buildDeepSeekViewModel({ phase: 'error' }, CONFIG)?.segments[0].text, '费用不可用')
  assert.equal(buildDeepSeekViewModel({ phase: 'disabled' }, CONFIG), undefined)
  assert.equal(buildDeepSeekViewModel({ phase: 'ready' }, { ...CONFIG, deepseekEnabled: false }), undefined)
})

test('shows the 60-second inline switch notice', () => {
  const model = buildDeepSeekViewModel({
    phase: 'ready',
    total: { cny: 77.26, currency: 'CNY' },
    today: { cny: 12.37, currency: 'CNY' },
    balance: { status: 'ok', currency: 'CNY', total: 86.5 },
    peak: { inPeak: false, label: '平价', nextLabel: '峰时', countdown: '1h29m' },
    notice: '平价',
    refreshing: false,
  }, CONFIG, { columns: 80 })
  assert.equal(model?.peakRow.label, '已进入平价')
  assert.equal(model?.peakRow.color, 'success')
})

test('peakConfigOf normalizes windows/holidays and defaults', () => {
  const config = peakConfigOf({
    peakEnabled: false,
    peakWindows: [{ start: 1, end: 4 }],
    peakHolidays: ['2026-10-01', 'bad'],
    peakEffectiveAt: '2026-08-01T00:00:00Z',
  })
  assert.equal(config.enabled, false)
  assert.deepEqual(config.windows, [{ start: 1, end: 4 }])
  assert.deepEqual(config.holidays, ['2026-10-01'])
  assert.equal(peakConfigOf({}).windows.length, 2)
})
