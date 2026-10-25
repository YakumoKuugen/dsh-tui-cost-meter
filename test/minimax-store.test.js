import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS } from '../lib/config.js'
import { MiniMaxPoller, MiniMaxStore } from '../lib/minimax-store.js'

const CONFIG = {
  ...DEFAULTS,
  minimaxEnabled: true,
  minimaxWindow: 'auto',
  minimaxBarWidth: 10,
  minimaxRefreshSeconds: 300,
}

function createPoller(overrides = {}) {
  const store = new MiniMaxStore()
  const config = { ...CONFIG, ...overrides.config }
  let now = overrides.now ?? Date.UTC(2026, 9, 24, 4, 31)
  let calls = 0
  const poller = new MiniMaxPoller({
    store,
    getConfig: () => config,
    resolveApiKey: async () => (overrides.noKey ? undefined : { value: 'sk-test' }),
    fetchQuota: async () => {
      calls += 1
      if (overrides.noKey) return { status: 'missing' }
      return overrides.result ?? {
        status: 'ok',
        intervalPercent: 68,
        weeklyPercent: 76,
        intervalUnlimited: false,
        weeklyUnlimited: false,
        model: 'general',
      }
    },
    getModel: () => overrides.model,
    now: () => now,
    logger: { warn: () => {} },
  })
  return {
    poller,
    store,
    config,
    setNow(value) { now = value },
    calls: () => calls,
    /** Start the poller and wait for its first refresh to settle. */
    async startAndWait() {
      poller.start()
      await poller.inflight
      return poller
    },
  }
}

test('loads the quota into the store', async () => {
  const { poller, store, startAndWait } = createPoller()
  await startAndWait()
  poller.stop()
  const state = store.getSnapshot()
  assert.equal(state.phase, 'ready')
  assert.equal(state.quota.intervalPercent, 68)
  assert.equal(state.quota.weeklyPercent, 76)
  assert.equal(state.refreshing, false)
})

test('passes the active model to the quota request', async () => {
  const { poller, store, startAndWait } = createPoller({ model: 'MiniMax-M3.1-Flash' })
  await startAndWait()
  poller.stop()
  assert.equal(store.getSnapshot().quota.model, 'general')
})

test('a missing key parks the line without an error', async () => {
  const { poller, store, startAndWait } = createPoller({ noKey: true })
  await startAndWait()
  poller.stop()
  assert.equal(store.getSnapshot().phase, 'disabled')
  assert.equal(store.getSnapshot().error, undefined)
})

test('a failed query reports an error phase', async () => {
  const { poller, store, startAndWait } = createPoller({ result: { status: 'error', message: 'boom' } })
  await startAndWait()
  poller.stop()
  assert.equal(store.getSnapshot().phase, 'error')
  assert.equal(store.getSnapshot().error, 'boom')
})

test('does not query while the line is disabled', async () => {
  const { poller, store, calls, startAndWait } = createPoller({ config: { minimaxEnabled: false } })
  await startAndWait()
  poller.stop()
  assert.equal(calls(), 0)
  assert.equal(store.getSnapshot().phase, 'disabled')
})
