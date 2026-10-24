import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEEPSEEK_BALANCE_URL,
  fetchDeepSeekBalance,
  fetchDeepSeekPlatformUsage,
  parseCredentialRecords,
  parseCredentialRefs,
  parseDeepSeekBalance,
  parsePlatformUsagePayload,
  projectCostMeterLedger,
  readCredentialFileValue,
  readDeepSeekAccountBalance,
  readCostMeterLedger,
  resolveDeepSeekApiKey,
} from '../lib/deepseek-client.js'

const NOW = Date.UTC(2026, 9, 24, 4, 31)

test('picks the CNY balance info and normalizes amounts', () => {
  const parsed = parseDeepSeekBalance({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '1.00', granted_balance: '0.00', topped_up_balance: '1.00' },
      { currency: 'CNY', total_balance: '86.50', granted_balance: '6.50', topped_up_balance: '80.00' },
    ],
  }, NOW)
  assert.equal(parsed.status, 'ok')
  assert.equal(parsed.currency, 'CNY')
  assert.equal(parsed.total, 86.5)
  assert.equal(parsed.granted, 6.5)
  assert.equal(parsed.topped, 80)
  assert.equal(parsed.fetchedAt, NOW)
})

test('reports unavailable and malformed balance payloads', () => {
  assert.equal(parseDeepSeekBalance({ is_available: false }, NOW).status, 'unavailable')
  assert.equal(parseDeepSeekBalance({ balance_infos: [] }, NOW).status, 'error')
  assert.equal(parseDeepSeekBalance({ balance_infos: [{ currency: 'CNY' }] }, NOW).status, 'error')
  assert.equal(parseDeepSeekBalance(null, NOW).status, 'error')
})

test('queries the official endpoint with a bearer key and bounded response', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, init }
    return {
      status: 200,
      ok: true,
      json: async () => ({
        is_available: true,
        balance_infos: [{ currency: 'CNY', total_balance: '86.50' }],
      }),
    }
  }
  const balance = await fetchDeepSeekBalance('secret-key', { fetchImpl, now: NOW })
  assert.equal(balance.status, 'ok')
  assert.equal(balance.total, 86.5)
  assert.equal(seen.url, DEEPSEEK_BALANCE_URL)
  assert.equal(seen.init.method, 'GET')
  assert.equal(seen.init.redirect, 'error')
  assert.equal(seen.init.headers.authorization, 'Bearer secret-key')
  assert.ok(seen.init.signal instanceof AbortSignal)
})

test('classifies balance HTTP failures without leaking the key', async () => {
  const unauthorized = await fetchDeepSeekBalance('secret-key', {
    fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({}) }),
  })
  assert.equal(unauthorized.status, 'unauthorized')
  assert.equal(JSON.stringify(unauthorized).includes('secret-key'), false)

  const failed = await fetchDeepSeekBalance('secret-key', {
    fetchImpl: async () => ({ status: 500, ok: false, json: async () => ({}) }),
  })
  assert.equal(failed.status, 'error')
  assert.match(failed.message, /HTTP 500/u)

  const missing = await fetchDeepSeekBalance(undefined)
  assert.equal(missing.status, 'missing')
})

test('reads the signed-in account wallet without an API key', async () => {
  const ctx = {
    get(name) {
      if (name !== 'deepseekAccount') return undefined
      return {
        async getBalance(client) {
          assert.equal(client.locale, 'zh')
          return {
            status: 'ready',
            value: [{ currency: 'CNY', balance: '80.00' }],
            bonusWallets: [{ currency: 'CNY', balance: '6.50' }],
          }
        },
      }
    },
  }
  const balance = await readDeepSeekAccountBalance(ctx, NOW)
  assert.equal(balance?.status, 'ok')
  assert.equal(balance?.currency, 'CNY')
  assert.equal(balance?.total, 86.5)
  assert.equal(balance?.granted, 6.5)
  assert.equal(balance?.topped, 80)
  assert.equal(balance?.source, 'account')
  assert.equal(await readDeepSeekAccountBalance({ get: () => undefined }, NOW), undefined)
})

test('parses the platform grant record without touching refs', () => {
  const parsed = parseCredentialRecords([
    'version: 1',
    'records:',
    '  deepseek-account-platform/default:',
    '    kind: grant',
    '    payload:',
    '      version: 1',
    '      token: abcdef',
    '      issuer: https://platform.deepseek.com',
    'refs:',
    '  DEEPSEEK_API_KEY: sk-test',
    '',
  ].join('\n'))
  assert.deepEqual(parsed.records['deepseek-account-platform/default'], {
    kind: 'grant',
    payload: { version: '1', token: 'abcdef', issuer: 'https://platform.deepseek.com' },
  })
})

test('parses this month and today from platform usage buckets', () => {
  const date = new Date(NOW)
  const todayStart = Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000)
  const earlier = todayStart - 86400
  const payload = {
    data: [{
      currency: 'CNY',
      series: [
        { buckets: [{ time: earlier, cost: '95.5' }, { time: todayStart, cost: '3.5' }] },
        { buckets: [{ time: todayStart, cost: '2.25' }] },
      ],
    }],
  }
  const parsed = parsePlatformUsagePayload(payload, NOW)
  assert.equal(parsed.status, 'ok')
  assert.equal(parsed.currency, 'CNY')
  assert.equal(parsed.month, 101.25)
  assert.equal(parsed.today, 5.75)
})

test('fetches the platform monthly cost with a day-aligned range', async () => {
  let seen
  const fetchImpl = async (url, init) => {
    seen = { url, init }
    return {
      status: 200,
      ok: true,
      json: async () => ({
        code: 0,
        data: {
          biz_code: 0,
          biz_data: {
            data: [{ currency: 'CNY', series: [{ buckets: [{ time: 1792771200, cost: '12.34' }] }] }],
          },
        },
      }),
    }
  }
  const usage = await fetchDeepSeekPlatformUsage(
    { token: 'account-token', issuer: 'https://platform.deepseek.com' },
    { fetchImpl, now: NOW },
  )
  assert.equal(usage.status, 'ok')
  assert.equal(usage.month, 12.34)
  const url = new URL(seen.url)
  assert.equal(url.origin, 'https://platform.deepseek.com')
  assert.equal(url.pathname, '/api/v0/usage/by_api_key/cost')
  assert.equal(url.searchParams.get('tz'), '28800')
  assert.equal(url.searchParams.get('start'), '1790784000')
  assert.equal(seen.init.headers['x-dsh-auth-token'], 'account-token')
})

test('handles missing/expired platform grants and business errors', async () => {
  assert.equal((await fetchDeepSeekPlatformUsage(undefined, { now: NOW })).status, 'missing')
  const unauthorized = await fetchDeepSeekPlatformUsage(
    { token: 'expired' },
    { fetchImpl: async () => ({ status: 401, ok: false, json: async () => ({}) }), now: NOW },
  )
  assert.equal(unauthorized.status, 'unauthorized')
  const invalid = await fetchDeepSeekPlatformUsage(
    { token: 'account-token' },
    { fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ data: { biz_code: 1, biz_msg: 'INVALID_PARAM' } }) }), now: NOW },
  )
  assert.equal(invalid.status, 'error')
  assert.match(invalid.message, /INVALID_PARAM/u)
})

test('reads refs from the credential document when the service is absent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-quota-cred-'))
  try {
    await writeFile(join(dir, '.credentials.yaml'), [
      'version: 1',
      'records:',
      '  some-id:',
      '    kind: grant',
      '    payload:',
      '      secret: ignored',
      'refs:',
      '  DEEPSEEK_API_KEY: sk-test-key',
      '  OTHER: "quoted"',
      '',
    ].join('\n'))
    assert.deepEqual(parseCredentialRefs(await (await import('node:fs/promises')).readFile(join(dir, '.credentials.yaml'), 'utf8')), {
      DEEPSEEK_API_KEY: 'sk-test-key',
      OTHER: 'quoted',
    })
    assert.deepEqual(await readCredentialFileValue({ DSH_HOME: dir }, ['DEEPSEEK_API_KEY']), {
      value: 'sk-test-key',
      source: 'credentials-file',
    })
    assert.deepEqual(await resolveDeepSeekApiKey({}, { DSH_HOME: dir }), {
      value: 'sk-test-key',
      source: 'credentials-file',
    })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('resolves the dedicated balance key before the inference key', async () => {
  const ctx = {
    get(name) {
      if (name === 'credentials') {
        return {
          async resolve(ref) {
            if (ref === 'DEEPSEEK_BALANCE_API_KEY') return { value: 'dedicated', source: 'file' }
            if (ref === 'DEEPSEEK_API_KEY') return { value: 'inference', source: 'file' }
            return undefined
          },
        }
      }
      return undefined
    },
  }
  assert.deepEqual(await resolveDeepSeekApiKey(ctx, {}), { value: 'dedicated', source: 'DEEPSEEK_BALANCE_API_KEY' })
})

test('falls back to the environment and respects a custom base URL', async () => {
  const ctx = {
    get(name) {
      if (name === 'settings') {
        return { get: () => ({ baseURL: 'https://relay.example.com', apiKeyEnv: 'RELAY_KEY' }) }
      }
      return undefined
    },
  }
  assert.deepEqual(
    await resolveDeepSeekApiKey(ctx, { DEEPSEEK_API_KEY: 'from-env' }),
    { value: 'from-env', source: 'DEEPSEEK_API_KEY' },
  )
  assert.equal(
    await resolveDeepSeekApiKey(ctx, { DSH_HOME: join(tmpdir(), 'codex-quota-empty-home'), RELAY_KEY: 'not-official' }),
    undefined,
  )
})

test('reads a ledger file and treats ENOENT as an empty but valid source', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-quota-ds-'))
  try {
    const path = join(dir, 'ledger.json')
    const now = Date.UTC(2026, 9, 24, 4, 31)
    const day = new Date(now).toLocaleDateString('en-CA')
    await writeFile(path, JSON.stringify({
      config: { currency: 'CNY', fxRates: { CNY: 7 }, peakEnabled: true },
      days: {
        [day]: { byProviderModel: { 'deepseek-official:flash': { cost: 1, costCny: 7, calls: 1 } } },
      },
    }))
    const projected = await readCostMeterLedger({ path, now })
    assert.equal(projected.present, true)
    assert.equal(projected.total.cny, 7)

    const missing = await readCostMeterLedger({ path: join(dir, 'absent.json'), now })
    assert.equal(missing.present, false)
    assert.equal(missing.total, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('projectCostMeterLedger rejects malformed documents', () => {
  assert.throws(() => projectCostMeterLedger(null), /not an object/u)
})
