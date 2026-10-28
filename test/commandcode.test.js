import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULTS } from '../lib/config.js'
import {
  COMMANDCODE_CREDENTIAL_NAMES,
  fetchCommandCodeQuota,
  isCommandCodeProvider,
  parseCommandCodeCredits,
  resolveCommandCodeApiKey,
} from '../lib/commandcode-client.js'
import {
  buildCommandCodeViewModel,
  formatCommandCodeStatusText,
  selectCommandCodeWindow,
} from '../lib/commandcode.js'

const CONFIG = {
  ...DEFAULTS,
  commandcodeEnabled: true,
  commandcodeWindow: 'auto',
  commandcodeBarWidth: 10,
  commandcodeShowCredits: true,
}

const LIVE = {
  credits: { monthlyCredits: 10, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    limited: true,
    exceeded: null,
    fiveHour: { used: 0, cap: 3, exceeded: false, resetAt: 0 },
    weekly: { used: 3, cap: 6, exceeded: false, resetAt: 1792957120711 },
  },
}

test('parses the credits payload into remaining percentages', () => {
  const parsed = parseCommandCodeCredits(LIVE)
  assert.equal(parsed.fiveHourPercent, 100)
  assert.equal(parsed.weeklyPercent, 50)
  assert.equal(parsed.monthlyCredits, 10)
  assert.equal(parsed.limited, true)
  assert.equal(parsed.exceeded, false)
  assert.equal(parsed.weeklyResetsAt, 1792957120711)
  assert.equal(parsed.fiveHourResetsAt, undefined)
})

test('marks an exhausted window and tolerates a missing wallet', () => {
  const parsed = parseCommandCodeCredits({
    windowLimits: { fiveHour: { used: 3, cap: 3, exceeded: true }, weekly: { used: 1, cap: 0 } },
  })
  assert.equal(parsed.fiveHourPercent, 0)
  assert.equal(parsed.exceeded, true)
  assert.equal(parsed.weeklyPercent, undefined)
  assert.equal(parsed.monthlyCredits, undefined)
})

test('rejects payloads without a usable window', () => {
  assert.equal(parseCommandCodeCredits(undefined), undefined)
  assert.equal(parseCommandCodeCredits({}), undefined)
  assert.equal(parseCommandCodeCredits({ windowLimits: {} }), undefined)
  assert.equal(parseCommandCodeCredits({ windowLimits: { fiveHour: { used: 1 } } }), undefined)
})

test('selects the 5-hour window by default and by explicit mode', () => {
  const quota = { fiveHourPercent: 80, weeklyPercent: 40 }
  assert.equal(selectCommandCodeWindow(quota, 'auto')?.percent, 80)
  assert.equal(selectCommandCodeWindow(quota, 'fiveHour')?.percent, 80)
  assert.equal(selectCommandCodeWindow(quota, 'weekly')?.percent, 40)
  assert.equal(selectCommandCodeWindow({ weeklyPercent: 40 }, 'auto')?.percent, 40)
  assert.equal(selectCommandCodeWindow({ weeklyPercent: 40 }, 'fiveHour'), undefined)
})

test('builds a ready row with the window, bar and credits', () => {
  const model = buildCommandCodeViewModel(
    { phase: 'ready', quota: { fiveHourPercent: 100, weeklyPercent: 50, monthlyCredits: 10 } },
    CONFIG,
  )
  assert.equal(model.kind, 'ready')
  assert.equal(model.windowLabel, '5h')
  assert.equal(model.percentText, '100%')
  assert.equal(model.creditsText, '$10')
  assert.equal(model.color, 'success')
  assert.equal(selectCommandCodeWindow({ fiveHourPercent: 0, exceeded: true }, 'auto')?.exceeded, true)
})

test('shows the second window and the granted credits when the API reports them', () => {
  const model = buildCommandCodeViewModel(
    {
      phase: 'ready',
      quota: { fiveHourPercent: 68, weeklyPercent: 41, monthlyCredits: 4.5, monthlyCreditsGranted: 10 },
    },
    CONFIG,
  )
  assert.equal(model.otherLabel, '7d')
  assert.equal(model.otherPercentText, '41%')
  assert.equal(model.creditsText, '$4.50/$10')
  assert.match(formatCommandCodeStatusText(model), /^CommandCode 5h [█░]+ 68% · 7d 41% · \$4\.50\/\$10$/u)
})

test('hides credits when the option is off and colors by remaining', () => {
  const model = buildCommandCodeViewModel(
    { phase: 'ready', quota: { fiveHourPercent: 4, weeklyPercent: 50, monthlyCredits: 10 } },
    { ...CONFIG, commandcodeShowCredits: false },
  )
  assert.equal(model.creditsText, undefined)
  assert.equal(model.color, 'error')
})

test('shows placeholders for waiting, failed and missing-key states', () => {
  assert.equal(buildCommandCodeViewModel({ phase: 'idle' }, CONFIG)?.placeholder, '读取中…')
  assert.equal(buildCommandCodeViewModel({ phase: 'error' }, CONFIG)?.placeholder, '额度不可用')
  assert.equal(buildCommandCodeViewModel({ phase: 'ready', quota: {} }, CONFIG)?.placeholder, '无额度数据')
  assert.equal(
    buildCommandCodeViewModel({ phase: 'disabled', reason: 'missing-key' }, CONFIG)?.placeholder,
    '未配置 API Key',
  )
  assert.equal(buildCommandCodeViewModel({ phase: 'disabled', reason: 'feature-off' }, CONFIG), undefined)
  assert.equal(buildCommandCodeViewModel({ phase: 'ready', quota: {} }, { ...CONFIG, commandcodeEnabled: false }), undefined)
})

test('formats the plain-text fallback', () => {
  const model = buildCommandCodeViewModel(
    { phase: 'ready', quota: { fiveHourPercent: 66.6, monthlyCredits: 7.5 } },
    CONFIG,
  )
  assert.match(formatCommandCodeStatusText(model), /^CommandCode 5h [█░]+ 67% · \$7\.50$/u)
})

test('recognises the CommandCode provider ids', () => {
  assert.equal(isCommandCodeProvider('command'), true)
  assert.equal(isCommandCodeProvider('commandcode'), true)
  assert.equal(isCommandCodeProvider('llm-command'), true)
  assert.equal(isCommandCodeProvider('minimax'), false)
  assert.equal(isCommandCodeProvider(undefined), false)
  assert.deepEqual(COMMANDCODE_CREDENTIAL_NAMES, ['COMMAND_API_KEY', 'COMMANDCODE_API_KEY'])
})

test('resolves the key from the credential service, then the environment, then the file', async () => {
  const ctx = { get: () => ({ resolve: async name => (name === 'COMMAND_API_KEY' ? { value: 'user_ctx' } : undefined) }) }
  assert.equal((await resolveCommandCodeApiKey(ctx, {})).value, 'user_ctx')

  const envOnly = await resolveCommandCodeApiKey({ get: () => undefined }, { COMMANDCODE_API_KEY: 'user_env' })
  assert.equal(envOnly.value, 'user_env')
  assert.equal(envOnly.source, 'COMMANDCODE_API_KEY')

  const dir = await mkdtemp(join(tmpdir(), 'cost-meter-commandcode-'))
  try {
    await writeFile(join(dir, '.credentials.yaml'), 'refs:\n  COMMAND_API_KEY: user_file\n')
    const hit = await resolveCommandCodeApiKey({ get: () => undefined }, { DSH_HOME: dir })
    assert.equal(hit.value, 'user_file')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  const empty = await mkdtemp(join(tmpdir(), 'cost-meter-commandcode-empty-'))
  try {
    assert.equal(await resolveCommandCodeApiKey({ get: () => undefined }, { DSH_HOME: empty }), undefined)
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})

test('queries the billing endpoint with a bearer key', async () => {
  let seen
  const result = await fetchCommandCodeQuota(
    { value: 'user_test' },
    {
      now: 1,
      fetchImpl: async (url, init) => {
        seen = { url, headers: init.headers }
        return {
          ok: true,
          status: 200,
          json: async () => LIVE,
        }
      },
    },
  )
  assert.equal(seen.url, 'https://api.commandcode.ai/alpha/billing/credits')
  assert.equal(seen.headers.authorization, 'Bearer user_test')
  assert.equal(result.status, 'ok')
  assert.equal(result.fiveHourPercent, 100)
  assert.equal(result.fetchedAt, 1)
})

test('reports auth and HTTP failures without leaking the key', async () => {
  const unauthorized = await fetchCommandCodeQuota(
    { value: 'user_secret' },
    { fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) },
  )
  assert.equal(unauthorized.status, 'error')
  assert.equal(unauthorized.message, 'CommandCode 登录已失效')
  assert.equal(unauthorized.message.includes('user_secret'), false)

  const serverError = await fetchCommandCodeQuota(
    { value: 'user_secret' },
    { fetchImpl: async () => ({ ok: false, status: 502, json: async () => ({}) }) },
  )
  assert.match(serverError.message, /HTTP 502/u)

  const missing = await fetchCommandCodeQuota(undefined, {})
  assert.equal(missing.status, 'missing')
})
