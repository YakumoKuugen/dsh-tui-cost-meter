import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS } from '../lib/config.js'
import {
  buildMiniMaxViewModel,
  formatMiniMaxStatusText,
  selectMiniMaxWindow,
} from '../lib/minimax.js'
import {
  fetchMiniMaxQuota,
  isMiniMaxProvider,
  parseMiniMaxRemains,
  resolveMiniMaxApiKey,
} from '../lib/minimax-client.js'

const CONFIG = {
  ...DEFAULTS,
  minimaxEnabled: true,
  minimaxWindow: 'auto',
  minimaxBarWidth: 10,
  minimaxWarnAt: 30,
  minimaxDangerAt: 10,
}

const REMAINS = {
  model_remains: [{
    model_name: 'general',
    current_interval_remaining_percent: 68,
    current_weekly_remaining_percent: 76,
    current_interval_status: 1,
    current_weekly_status: 1,
  }],
}

test('parses the token plan remains payload', () => {
  const parsed = parseMiniMaxRemains(REMAINS)
  assert.equal(parsed?.intervalPercent, 68)
  assert.equal(parsed?.weeklyPercent, 76)
  assert.equal(parsed?.model, 'general')
  assert.equal(parsed?.intervalUnlimited, false)
})

test('prefers the requested model row over the general one', () => {
  const payload = {
    model_remains: [
      { model_name: 'general', current_interval_remaining_percent: 10 },
      { model_name: 'MiniMax-M3.1-Flash', current_interval_remaining_percent: 55 },
    ],
  }
  assert.equal(parseMiniMaxRemains(payload, 'MiniMax-M3.1-Flash')?.intervalPercent, 55)
  // Without a model in use the shared `general` row is the plan's aggregate.
  assert.equal(parseMiniMaxRemains(payload)?.intervalPercent, 10)
})

test('reports an unlimited window when the status says so', () => {
  const parsed = parseMiniMaxRemains({
    model_remains: [{ model_name: 'general', current_interval_status: 3, current_weekly_remaining_percent: 100 }],
  })
  assert.equal(parsed?.intervalUnlimited, true)
  assert.equal(parsed?.weeklyPercent, 100)
})

test('rejects a payload without any quota field', () => {
  assert.equal(parseMiniMaxRemains({ base_resp: { status_code: 0 } }), undefined)
  assert.equal(parseMiniMaxRemains(null), undefined)
})

test('selects the window by mode', () => {
  const quota = { intervalPercent: 68, weeklyPercent: 76 }
  assert.equal(selectMiniMaxWindow(quota, 'auto')?.key, '5h')
  assert.equal(selectMiniMaxWindow(quota, 'interval')?.key, '5h')
  assert.equal(selectMiniMaxWindow(quota, 'weekly')?.key, '7d')
  assert.equal(selectMiniMaxWindow({ weeklyPercent: 76 }, 'auto')?.key, '7d')
  assert.equal(selectMiniMaxWindow(undefined, 'auto'), undefined)
})

test('builds the MiniMax row with a bar and percentage', () => {
  const model = buildMiniMaxViewModel(
    { phase: 'ready', quota: { intervalPercent: 68, weeklyPercent: 76 } },
    CONFIG,
    { columns: 80 },
  )
  assert.equal(model?.kind, 'ready')
  assert.equal(model?.windowLabel, '5h')
  assert.equal(model?.percentText, '68%')
  assert.equal(model?.filledText.length, 7)
  assert.equal(model?.emptyText.length, 3)
  assert.equal(formatMiniMaxStatusText(model), 'MiniMax 5h ███████░░░ 68%')
})

test('turns the bar amber and red at the configured thresholds', () => {
  const amber = buildMiniMaxViewModel({ phase: 'ready', quota: { intervalPercent: 25 } }, CONFIG)
  assert.equal(amber?.color, 'warning')
  const red = buildMiniMaxViewModel({ phase: 'ready', quota: { intervalPercent: 5 } }, CONFIG)
  assert.equal(red?.color, 'error')
})

test('shows placeholders for missing, loading and failed states', () => {
  assert.equal(buildMiniMaxViewModel({ phase: 'idle' }, CONFIG)?.placeholder, '读取中…')
  assert.equal(buildMiniMaxViewModel({ phase: 'error' }, CONFIG)?.placeholder, '额度不可用')
  assert.equal(buildMiniMaxViewModel({ phase: 'ready', quota: {} }, CONFIG)?.placeholder, '无额度数据')
  assert.equal(buildMiniMaxViewModel({ phase: 'disabled', reason: 'feature-off' }, CONFIG), undefined)
  assert.equal(
    buildMiniMaxViewModel({ phase: 'disabled', reason: 'missing-key' }, CONFIG)?.placeholder,
    '未配置 API Key',
  )
  assert.equal(buildMiniMaxViewModel({ phase: 'ready' }, { ...CONFIG, minimaxEnabled: false }), undefined)
})

test('renders an unlimited window', () => {
  const model = buildMiniMaxViewModel(
    { phase: 'ready', quota: { intervalUnlimited: true, weeklyPercent: 100 } },
    CONFIG,
  )
  assert.equal(model?.unlimited, true)
  assert.equal(model?.percentText, '不限')
})

test('recognises the MiniMax provider ids', () => {
  assert.equal(isMiniMaxProvider('minimax'), true)
  assert.equal(isMiniMaxProvider('minimax-cn'), true)
  assert.equal(isMiniMaxProvider('minimax-other'), true)
  assert.equal(isMiniMaxProvider('deepseek'), false)
  assert.equal(isMiniMaxProvider(undefined), false)
})

test('resolves the key from the credential service, then the environment', async () => {
  const ctx = {
    get(name) {
      if (name !== 'credentials') return undefined
      return {
        async resolve(ref) {
          if (ref === 'MINIMAX_CN_API_KEY') return { value: 'from-service', source: 'file' }
          return undefined
        },
      }
    },
  }
  assert.deepEqual(await resolveMiniMaxApiKey(ctx, {}), {
    value: 'from-service',
    source: 'MINIMAX_CN_API_KEY',
  })
  assert.deepEqual(await resolveMiniMaxApiKey({ get: () => undefined }, { MINIMAX_API_KEY: 'from-env' }), {
    value: 'from-env',
    source: 'MINIMAX_API_KEY',
  })
})

test('queries the token plan endpoint with a bearer key', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, init }
    return { status: 200, ok: true, json: async () => REMAINS }
  }
  const quota = await fetchMiniMaxQuota({ value: 'sk-test' }, { fetchImpl, now: 1000 })
  assert.equal(quota.status, 'ok')
  assert.equal(quota.intervalPercent, 68)
  assert.equal(seen.url, 'https://www.minimaxi.com/v1/token_plan/remains')
  assert.equal(seen.init.headers.authorization, 'Bearer sk-test')
  assert.equal(seen.init.redirect, 'error')
  assert.ok(seen.init.signal instanceof AbortSignal)
})

test('falls back to the international domain and reports failures', async () => {
  const tried = []
  const fetchImpl = async (url) => {
    tried.push(url)
    if (url.includes('minimaxi.com')) return { status: 401, ok: false, json: async () => ({}) }
    return { status: 200, ok: true, json: async () => REMAINS }
  }
  const quota = await fetchMiniMaxQuota({ value: 'sk-test' }, { fetchImpl, now: 1000 })
  assert.equal(quota.status, 'ok')
  assert.equal(tried.length, 2)
  assert.ok(tried[1].includes('minimax.io'))

  const missing = await fetchMiniMaxQuota(undefined, { now: 1000 })
  assert.equal(missing.status, 'missing')
  const failed = await fetchMiniMaxQuota(
    { value: 'sk-test' },
    { fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({}) }), now: 1000 },
  )
  assert.equal(failed.status, 'error')
  assert.equal(JSON.stringify(failed).includes('sk-test'), false)
})
