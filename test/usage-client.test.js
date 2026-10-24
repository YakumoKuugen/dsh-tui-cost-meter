import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CODEX_USAGE_URL,
  CodexAuthError,
  fetchCodexUsage,
  parseCodexUsage,
} from '../lib/usage-client.js'

const SAMPLE = {
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: {
      used_percent: 0,
      limit_window_seconds: 604_800,
      reset_after_seconds: 604_800,
      reset_at: 1_793_386_283,
    },
    secondary_window: null,
  },
  credits: {
    has_credits: false,
    unlimited: false,
    balance: '0',
  },
  spend_control: {
    reached: false,
    individual_limit: null,
  },
}

const CREDENTIAL = { accessToken: 'access-token', accountId: 'account-id' }

test('parses the live weekly-only shape', () => {
  const usage = parseCodexUsage(SAMPLE)
  assert.equal(usage.rateLimits.length, 1)
  assert.equal(usage.rateLimits[0].id, 'codex')
  assert.equal(usage.rateLimits[0].windows.length, 1)
  assert.equal(usage.rateLimits[0].windows[0].remainingPercent, 100)
  assert.equal(usage.rateLimits[0].windows[0].windowSeconds, 604_800)
  assert.equal(usage.rateLimits[0].windows[0].resetAt, 1_793_386_283)
  assert.equal(usage.credits, undefined)
  assert.equal(usage.individualLimit, undefined)
})

test('parses 5-hour + weekly pairs and additional buckets', () => {
  const usage = parseCodexUsage({
    rate_limit: {
      primary_window: { used_percent: 37, limit_window_seconds: 18_000, reset_at: 100 },
      secondary_window: { used_percent: 12.5, limit_window_seconds: 604_800 },
    },
    additional_rate_limits: [{
      metered_feature: 'code_review',
      limit_name: 'Code review',
      rate_limit: {
        primary_window: { used_percent: 50, limit_window_seconds: 604_800 },
      },
    }],
  })
  assert.equal(usage.rateLimits.length, 2)
  assert.equal(usage.rateLimits[0].windows[0].remainingPercent, 63)
  assert.equal(usage.rateLimits[0].windows[1].remainingPercent, 87.5)
  assert.equal(usage.rateLimits[1].id, 'code_review')
  assert.equal(usage.rateLimits[1].name, 'Code review')
})

test('parses credits and an individual spend limit', () => {
  const usage = parseCodexUsage({
    rate_limit: SAMPLE.rate_limit,
    credits: { has_credits: true, unlimited: false, balance: '12.50' },
    spend_control: {
      individual_limit: { limit: '50', used: '10', remaining: '40', remaining_percent: 80 },
    },
  })
  assert.deepEqual(usage.credits, { unlimited: false, balance: '12.50' })
  assert.deepEqual(usage.individualLimit, {
    limit: '50',
    used: '10',
    remaining: '40',
    remainingPercent: 80,
  })
})

test('rejects malformed roots but tolerates empty windows', () => {
  assert.throws(() => parseCodexUsage(null), /malformed/u)
  assert.throws(() => parseCodexUsage('nope'), /malformed/u)
  assert.deepEqual(parseCodexUsage({ rate_limit: null }), { rateLimits: [] })
  assert.deepEqual(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 'x' } } }), { rateLimits: [] })
})

test('fetches with the official headers', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, init }
    return { status: 200, ok: true, json: async () => SAMPLE }
  }
  const usage = await fetchCodexUsage(CREDENTIAL, fetchImpl)
  assert.equal(usage.rateLimits[0].windows[0].remainingPercent, 100)
  assert.equal(seen.url, CODEX_USAGE_URL)
  assert.equal(seen.init.method, 'GET')
  assert.equal(seen.init.redirect, 'error')
  assert.equal(seen.init.headers.authorization, 'Bearer access-token')
  assert.equal(seen.init.headers['chatgpt-account-id'], 'account-id')
  assert.ok(seen.init.signal instanceof AbortSignal)
})

test('maps 401 to an auth error but leaves 403 as a service failure', async () => {
  await assert.rejects(
    fetchCodexUsage(CREDENTIAL, async () => ({ status: 401, ok: false, json: async () => ({}) })),
    error => error instanceof CodexAuthError && error.code === 'CODEX_AUTH_EXPIRED',
  )
  // Cloudflare and rate limits use 403 too; it must not become "登录已过期".
  await assert.rejects(
    fetchCodexUsage(CREDENTIAL, async () => ({ status: 403, ok: false, json: async () => ({}) })),
    /HTTP 403/u,
  )
})

test('reports HTTP failures without leaking the token', async () => {
  await assert.rejects(
    fetchCodexUsage(CREDENTIAL, async () => ({ status: 500, ok: false, json: async () => ({}) })),
    /HTTP 500/u,
  )
})

test('reports unreadable JSON', async () => {
  await assert.rejects(
    fetchCodexUsage(CREDENTIAL, async () => ({
      status: 200,
      ok: true,
      json: async () => {
        throw new Error('bad json')
      },
    })),
    /unreadable usage response/u,
  )
})
