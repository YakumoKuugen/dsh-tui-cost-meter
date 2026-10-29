import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS } from '../lib/config.js'
import { CommandCodePoller, CommandCodeStore } from '../lib/commandcode-store.js'

const CONFIG = {
  ...DEFAULTS,
  commandcodeEnabled: true,
  commandcodeWindow: 'auto',
  commandcodeBarWidth: 10,
  commandcodeRefreshSeconds: 300,
}

function createPoller(overrides = {}) {
  const store = new CommandCodeStore()
  const config = { ...CONFIG, ...overrides.config }
  let now = overrides.now ?? Date.UTC(2026, 9, 29, 3, 0)
  let calls = 0
  const poller = new CommandCodePoller({
    store,
    getConfig: () => config,
    resolveApiKeys: async () => (overrides.noKey
      ? []
      : (overrides.keys ?? [{ value: 'user_test', source: 'COMMAND_API_KEY' }])),
    fetchQuota: async (credential) => {
      calls += 1
      if (overrides.noKey) return { status: 'missing' }
      if (overrides.perKey?.[credential.value] !== undefined) return overrides.perKey[credential.value]
      return overrides.result ?? {
        status: 'ok',
        fiveHourPercent: 100,
        weeklyPercent: 50,
        monthlyCredits: 10,
        limited: true,
        exceeded: false,
      }
    },
    now: () => now,
    logger: { warn: () => {} },
  })
  return {
    poller,
    store,
    config,
    setNow(value) { now = value },
    calls: () => calls,
    async startAndWait() {
      poller.start()
      await poller.inflight
      return poller
    },
  }
}

test('loads the CommandCode quota into the store', async () => {
  const { poller, store, startAndWait } = createPoller()
  await startAndWait()
  poller.stop()
  const state = store.getSnapshot()
  assert.equal(state.phase, 'ready')
  assert.equal(state.quota.fiveHourPercent, 100)
  assert.equal(state.quota.weeklyPercent, 50)
  assert.equal(state.quota.monthlyCredits, 10)
  assert.equal(state.refreshing, false)
})

test('a missing key parks the line at the placeholder state', async () => {
  const { poller, store, startAndWait } = createPoller({ noKey: true })
  await startAndWait()
  poller.stop()
  assert.equal(store.getSnapshot().phase, 'disabled')
  assert.equal(store.getSnapshot().reason, 'missing-key')
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
  const { poller, store, calls, startAndWait } = createPoller({ config: { commandcodeEnabled: false } })
  await startAndWait()
  poller.stop()
  assert.equal(calls(), 0)
  assert.equal(store.getSnapshot().phase, 'disabled')
  assert.equal(store.getSnapshot().reason, 'feature-off')
})

test('falls back to the next key when one is rejected', async () => {
  const { poller, store, startAndWait } = createPoller({
    keys: [
      { value: 'stale', source: 'COMMAND_API_KEY' },
      { value: 'fresh', source: 'COMMANDCODE_API_KEY' },
    ],
    perKey: {
      stale: { status: 'error', code: 'auth', message: 'CommandCode 登录已失效' },
    },
  })
  await startAndWait()
  poller.stop()
  const state = store.getSnapshot()
  assert.equal(state.phase, 'ready')
  assert.equal(state.keySource, 'COMMANDCODE_API_KEY')
  assert.equal(state.quota.monthlyCredits, 10)
})

test('does not burn through keys on a network failure', async () => {
  let attempts = 0
  const { poller, store, startAndWait } = createPoller({
    keys: [
      { value: 'a', source: 'COMMAND_API_KEY' },
      { value: 'b', source: 'COMMANDCODE_API_KEY' },
    ],
  })
  poller.fetchQuota = async () => {
    attempts += 1
    return { status: 'error', code: 'network', message: 'boom' }
  }
  await startAndWait()
  poller.stop()
  assert.equal(attempts, 1)
  assert.equal(store.getSnapshot().phase, 'error')
  assert.equal(store.getSnapshot().errorCode, 'network')
})

test('parks at missing-key when no candidate is configured', async () => {
  const { poller, store, startAndWait } = createPoller({ noKey: true })
  await startAndWait()
  poller.stop()
  assert.equal(store.getSnapshot().phase, 'disabled')
  assert.equal(store.getSnapshot().reason, 'missing-key')
})

test('throttles repeated manual refreshes', async () => {
  const { poller, calls, startAndWait } = createPoller()
  await startAndWait()
  await poller.refreshManually()
  await poller.refreshManually()
  poller.stop()
  assert.equal(calls(), 2)
})
