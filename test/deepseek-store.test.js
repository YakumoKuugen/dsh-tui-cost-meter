import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS } from '../lib/config.js'
import { DEFAULT_PEAK_WINDOWS } from '../lib/deepseek.js'
import { DeepSeekPoller, DeepSeekStore } from '../lib/deepseek-store.js'

const PEAK = {
  enabled: true,
  windows: DEFAULT_PEAK_WINDOWS.map(window => ({ ...window })),
  holidays: [],
  effectiveAtMs: Date.parse('2026-08-01T00:00:00Z'),
}

const LEDGER = {
  present: true,
  total: { cny: 77.26, currency: 'CNY' },
  month: { cny: 50.25, currency: 'CNY' },
  today: { cny: 12.37, currency: 'CNY' },
  peakConfig: PEAK,
  currency: 'CNY',
  updatedAt: Date.UTC(2026, 9, 23, 5, 59),
}

const BALANCE = { status: 'ok', currency: 'CNY', total: 86.5, fetchedAt: Date.UTC(2026, 9, 23, 5, 59) }

function createPoller(overrides = {}) {
  const store = new DeepSeekStore()
  const config = {
    ...DEFAULTS,
    deepseekEnabled: true,
    deepseekShowBalance: true,
    deepseekShowPeak: true,
    deepseekPeakNotify: true,
    deepseekRefreshSeconds: 300,
    ...overrides.config,
  }
  let now = overrides.now ?? Date.UTC(2026, 9, 23, 5, 59) // Friday 13:59 Beijing
  const notifications = []
  const warnings = []
  let failLedger = false
  let ledgerCalls = 0
  let balanceCalls = 0
  const poller = new DeepSeekPoller({
    store,
    getConfig: () => config,
    readLedger: async () => {
      ledgerCalls += 1
      if (failLedger) throw new Error('ledger boom')
      return overrides.ledger ?? LEDGER
    },
    readAccountBalance: overrides.readAccountBalance ?? (async () => undefined),
    readPlatformUsage: overrides.readPlatformUsage ?? (async () => ({ status: 'missing' })),
    resolveApiKey: async () => (overrides.noKey ? undefined : { value: 'key' }),
    fetchBalance: async () => {
      balanceCalls += 1
      return overrides.balance ?? BALANCE
    },
    notify: (text, color) => notifications.push({ text, color }),
    now: () => now,
    tickMs: 60_000,
    logger: { warn: message => warnings.push(message) },
  })
  return {
    poller,
    store,
    notifications,
    warnings,
    config,
    setNow(value) { now = value },
    failLedger(value) { failLedger = value },
    counts() { return { ledgerCalls, balanceCalls } },
  }
}

async function startAndSettle(poller) {
  poller.start()
  await poller.inflight
}

test('loads ledger + balance and does not toast on the first tick', async () => {
  const { poller, store, notifications } = createPoller()
  await startAndSettle(poller)
  poller.stop()
  const state = store.getSnapshot()
  assert.equal(state.phase, 'ready')
  assert.equal(state.total.cny, 77.26)
  assert.equal(state.today.cny, 12.37)
  assert.equal(state.balance.total, 86.5)
  assert.equal(state.peak.inPeak, false)
  assert.equal(notifications.length, 0)
})

test('toasts and shows a 60s inline notice when peak starts and ends', async () => {
  const { poller, store, notifications, setNow } = createPoller()
  await startAndSettle(poller)

  setNow(Date.UTC(2026, 9, 23, 6, 0, 30)) // 14:00:30 Beijing, peak starts
  poller.tick()
  assert.equal(notifications.length, 1)
  assert.match(notifications[0].text, /峰时/u)
  assert.equal(notifications[0].color, 'warning')
  assert.equal(store.getSnapshot().notice, '峰时')

  setNow(Date.UTC(2026, 9, 23, 6, 1, 31)) // notice expires, still peak
  poller.tick()
  assert.equal(store.getSnapshot().notice, undefined)

  setNow(Date.UTC(2026, 9, 23, 10, 0, 30)) // 18:00:30 Beijing, off-peak
  poller.tick()
  poller.stop()
  assert.equal(notifications.length, 2)
  assert.match(notifications[1].text, /平价/u)
  assert.equal(notifications[1].color, 'success')
  assert.equal(store.getSnapshot().notice, '平价')
})

test('does not toast when peak notifications are disabled', async () => {
  const { poller, notifications, setNow } = createPoller({
    config: { deepseekPeakNotify: false },
  })
  await startAndSettle(poller)
  setNow(Date.UTC(2026, 9, 23, 6, 0, 30))
  poller.tick()
  poller.stop()
  assert.equal(notifications.length, 0)
})

test('keeps the previous totals when the ledger read fails', async () => {
  const { poller, store, warnings, setNow, failLedger } = createPoller()
  await startAndSettle(poller)
  failLedger(true)
  setNow(Date.UTC(2026, 9, 23, 6, 10, 0)) // > 300s, triggers refresh
  poller.tick()
  await poller.inflight
  poller.stop()
  const state = store.getSnapshot()
  assert.equal(state.phase, 'ready')
  assert.equal(state.total.cny, 77.26)
  assert.match(state.error, /账本读取失败/u)
  assert.ok(warnings.some(message => /账本读取失败/u.test(message)))
})

test('prefers the platform monthly usage over the ledger month', async () => {
  const { poller, store } = createPoller({
    readPlatformUsage: async () => ({ status: 'ok', currency: 'CNY', month: 128.99, today: 5.5 }),
  })
  await startAndSettle(poller)
  poller.stop()
  const state = store.getSnapshot()
  assert.equal(state.month.cny, 128.99)
  assert.equal(state.today.cny, 5.5)
  assert.equal(state.usageSource, 'platform')
  assert.equal(state.total.cny, 77.26)
})

test('falls back to the ledger month when platform usage is unavailable', async () => {
  const { poller, store } = createPoller({
    readPlatformUsage: async () => ({ status: 'unauthorized', message: 'no' }),
  })
  await startAndSettle(poller)
  poller.stop()
  const state = store.getSnapshot()
  assert.equal(state.month.cny, 50.25)
  assert.equal(state.today.cny, 12.37)
  assert.equal(state.usageSource, undefined)
})

test('uses the signed-in account wallet before the API key', async () => {
  const { poller, store, config } = createPoller({
    readAccountBalance: async () => ({ status: 'ok', currency: 'CNY', total: 86.5, source: 'account' }),
  })
  await startAndSettle(poller)
  poller.stop()
  assert.equal(store.getSnapshot().balance.total, 86.5)
  assert.equal(store.getSnapshot().balance.source, 'account')
  assert.equal(config.deepseekEnabled, true)
})

test('still shows the ledger when no balance key is configured', async () => {
  const { poller, store } = createPoller({ noKey: true })
  await startAndSettle(poller)
  poller.stop()
  const state = store.getSnapshot()
  assert.equal(state.phase, 'ready')
  assert.equal(state.total.cny, 77.26)
  assert.equal(state.balance.status, 'missing')
})

test('does not fetch when the DeepSeek line is disabled', async () => {
  const { poller, store, counts } = createPoller({ config: { deepseekEnabled: false } })
  poller.start()
  poller.stop()
  assert.equal(store.getSnapshot().phase, 'disabled')
  assert.deepEqual(counts(), { ledgerCalls: 0, balanceCalls: 0 })
})

test('manual refresh is throttled for five seconds', async () => {
  const { poller, counts } = createPoller()
  await startAndSettle(poller)
  const before = counts().balanceCalls
  await poller.refreshManually()
  await poller.refreshManually()
  poller.stop()
  assert.equal(counts().balanceCalls, before + 1)
})
