import test from 'node:test'
import assert from 'node:assert/strict'

import { QuotaPoller, QuotaStore, safeErrorText } from '../lib/store.js'
import { CodexAuthError } from '../lib/usage-client.js'

const USAGE = {
  rateLimits: [{
    id: 'codex',
    windows: [{ remainingPercent: 75, windowSeconds: 18_000 }],
  }],
}

function baseConfig(overrides = {}) {
  return {
    enabled: true,
    window: 'auto',
    barWidth: 10,
    showLabel: true,
    showReset: false,
    showUnavailable: true,
    warnAt: 30,
    dangerAt: 10,
    refreshSeconds: 60,
    ...overrides,
  }
}

function createPoller(overrides = {}) {
  const store = overrides.store ?? new QuotaStore()
  const warnings = []
  const poller = new QuotaPoller({
    store,
    getConfig: overrides.getConfig ?? (() => baseConfig()),
    getService: overrides.getService ?? (() => undefined),
    readCredential: overrides.readCredential ?? (async () => ({ accessToken: 'a', accountId: 'b', expired: false })),
    fetchUsage: overrides.fetchUsage ?? (async () => USAGE),
    logger: { warn: message => warnings.push(message) },
    now: overrides.now,
    minRefreshSeconds: 0.01,
  })
  return { poller, store, warnings }
}

test('uses the signed-in dsh-codex service first', async () => {
  let usageCalls = 0
  let credentialReads = 0
  const { poller, store } = createPoller({
    getService: () => ({
      authStatus: async () => ({ authenticated: true }),
      usage: async force => {
        usageCalls += 1
        assert.equal(force, false)
        return USAGE
      },
    }),
    readCredential: async () => {
      credentialReads += 1
      return undefined
    },
  })
  await poller.start()
  poller.stop()
  assert.equal(usageCalls, 1)
  assert.equal(credentialReads, 0)
  assert.equal(store.getSnapshot().phase, 'ready')
  assert.equal(store.getSnapshot().usage, USAGE)
  assert.equal(store.getSnapshot().refreshing, false)
})

test('falls back to a credential document when dsh-codex is signed out', async () => {
  let fetchCalls = 0
  const { poller, store } = createPoller({
    getService: () => ({
      authStatus: async () => ({ authenticated: false }),
      usage: async () => {
        throw new Error('should not be called')
      },
    }),
    fetchUsage: async credential => {
      fetchCalls += 1
      assert.equal(credential.accountId, 'b')
      return USAGE
    },
  })
  await poller.start()
  poller.stop()
  assert.equal(fetchCalls, 1)
  assert.equal(store.getSnapshot().phase, 'ready')
})

test('reports signed-out when no credential exists', async () => {
  const { poller, store } = createPoller({
    readCredential: async () => undefined,
  })
  await poller.start()
  poller.stop()
  assert.equal(store.getSnapshot().phase, 'signed-out')
  assert.equal(store.getSnapshot().usage, undefined)
})

test('tries a locally expired access token instead of declaring the login dead', async () => {
  let fetchCalls = 0
  const { poller, store } = createPoller({
    readCredential: async () => ({ accessToken: 'a', accountId: 'b', expired: true }),
    fetchUsage: async () => {
      fetchCalls += 1
      return USAGE
    },
  })
  await poller.start()
  poller.stop()
  assert.equal(fetchCalls, 1)
  assert.equal(store.getSnapshot().phase, 'ready')
})

test('keeps the last good reading on a transient network error and recovers', async () => {
  const store = new QuotaStore({ phase: 'ready', usage: USAGE })
  let fail = true
  const { poller, warnings } = createPoller({
    store,
    fetchUsage: async () => {
      if (fail) throw new Error('network down')
      return USAGE
    },
  })
  await poller.start()
  assert.equal(store.getSnapshot().phase, 'error')
  assert.equal(store.getSnapshot().usage, USAGE)
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /codex-quota/i)

  fail = false
  await poller.poll()
  poller.stop()
  assert.equal(store.getSnapshot().phase, 'ready')
  assert.equal(store.getSnapshot().error, undefined)
})

test('keeps the last reading through transient auth failures, then expires', async () => {
  const store = new QuotaStore({ phase: 'ready', usage: USAGE })
  let calls = 0
  const { poller } = createPoller({
    store,
    fetchUsage: async () => {
      calls += 1
      throw new CodexAuthError()
    },
  })

  await poller.start()
  assert.equal(store.getSnapshot().phase, 'auth-pending')
  assert.equal(store.getSnapshot().usage, USAGE)

  await poller.poll()
  assert.equal(store.getSnapshot().phase, 'auth-pending')
  assert.equal(store.getSnapshot().usage, USAGE)

  await poller.poll()
  poller.stop()
  assert.equal(calls, 3)
  assert.equal(store.getSnapshot().phase, 'expired')
  assert.equal(store.getSnapshot().usage, undefined)
})

test('recovers from auth-pending on the next successful poll', async () => {
  const store = new QuotaStore({ phase: 'ready', usage: USAGE })
  let fail = true
  const { poller } = createPoller({
    store,
    fetchUsage: async () => {
      if (fail) throw new CodexAuthError()
      return USAGE
    },
  })
  await poller.start()
  assert.equal(store.getSnapshot().phase, 'auth-pending')

  fail = false
  await poller.poll()
  poller.stop()
  assert.equal(store.getSnapshot().phase, 'ready')
  assert.equal(store.getSnapshot().usage, USAGE)
})

test('does not call a bare HTTP 403 an expired login', async () => {
  const store = new QuotaStore({ phase: 'ready', usage: USAGE })
  const { poller } = createPoller({
    store,
    fetchUsage: async () => {
      throw new Error('Codex usage request failed with HTTP 403')
    },
  })
  await poller.start()
  poller.stop()
  assert.equal(store.getSnapshot().phase, 'error')
  assert.equal(store.getSnapshot().usage, USAGE)
})

test('does not poll while disabled', async () => {
  let fetchCalls = 0
  const { poller, store } = createPoller({
    getConfig: () => baseConfig({ enabled: false }),
    fetchUsage: async () => {
      fetchCalls += 1
      return USAGE
    },
  })
  await poller.start()
  poller.stop()
  assert.equal(fetchCalls, 0)
  assert.equal(store.getSnapshot().phase, 'disabled')
})

test('deduplicates concurrent polls', async () => {
  let resolveFetch
  const pending = new Promise(resolve => {
    resolveFetch = resolve
  })
  const { poller, store } = createPoller({
    fetchUsage: async () => {
      await pending
      return USAGE
    },
  })
  const first = poller.start()
  const second = poller.poll()
  assert.equal(first, second)
  resolveFetch()
  await first
  poller.stop()
  assert.equal(store.getSnapshot().phase, 'ready')
})

test('debounces manual refresh clicks within five seconds', async () => {
  let now = 100_000
  let fetchCalls = 0
  const { poller } = createPoller({
    now: () => now,
    fetchUsage: async () => {
      fetchCalls += 1
      return USAGE
    },
  })
  await poller.start()
  fetchCalls = 0
  now += 10_000
  await poller.refreshManually()
  assert.equal(fetchCalls, 1)
  now += 1_000
  assert.equal(poller.refreshManually(), undefined)
  await Promise.resolve()
  assert.equal(fetchCalls, 1)
  poller.stop()
})

test('redacts token-shaped text in errors', () => {
  const token = 'eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature'
  assert.equal(safeErrorText(new Error(`bad ${token}`)), 'bad [redacted token]')
  assert.ok(safeErrorText(new Error('x'.repeat(1000))).length <= 300)
})
