/**
 * CommandCode quota — read-only.
 *
 * CommandCode (api.commandcode.ai) exposes the plan behind the `command`
 * provider: a 5-hour and a weekly usage window (`used` / `cap` counters) plus
 * a monthly credits wallet. The endpoint is the same one the dsh-cost-meter
 * coding-plan adapter uses: `GET /alpha/billing/credits`.
 *
 * Window counters are USED amounts, so this module converts them to the
 * remaining percentages the status row shows for Codex and MiniMax.
 *
 * Credentials come from the host credential service first, then the
 * environment, then the host credential document. Nothing is written and the
 * key never reaches a status line or an error message.
 */

import { readCredentialFileValue, readCredentialFileValues } from './credential-file.js'
import { USER_AGENT } from './version.js'

/**
 * Credential names in preference order. `COMMAND_API_KEY` is the key the
 * `command` provider already uses for inference; `COMMANDCODE_API_KEY` is the
 * name dsh-cost-meter documents for the same account.
 */
export const COMMANDCODE_CREDENTIAL_NAMES = ['COMMAND_API_KEY', 'COMMANDCODE_API_KEY']

/** CommandCode API origin. */
export const COMMANDCODE_ORIGIN = 'https://api.commandcode.ai'

/** Billing-credits path (windows + monthly wallet). */
export const COMMANDCODE_CREDITS_PATH = '/alpha/billing/credits'

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'string' && value.trim().length > 0) {
    const number = Number(value)
    return Number.isFinite(number) ? number : undefined
  }
  return undefined
}

function clampPercent(value) {
  const number = finiteNumber(value)
  if (number === undefined) return undefined
  return Math.max(0, Math.min(100, number))
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function safeGet(ctx, name) {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

/** Whether a provider id routes to CommandCode. */
export function isCommandCodeProvider(provider) {
  if (typeof provider !== 'string') return false
  const id = provider.toLowerCase().replace(/^llm-/, '')
  return id === 'command' || id === 'commandcode' || id === 'command-code' || id.startsWith('commandcode-')
}

/**
 * Resolve every plausible CommandCode API key, most specific first.
 *
 * More than one source can hold a key, and they drift: `cmd login` rotates the
 * key, the credential document gets the new one, and a process that started
 * earlier can still hold the old value in its environment or in the credential
 * service. Returning all candidates lets the poller retry with the next one
 * instead of showing an auth error until the process restarts.
 *
 * @param {object} ctx - plugin context
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Array<{value: string, source: string}>>}
 */
export async function resolveCommandCodeApiKeys(ctx, env = process.env) {
  const keys = []
  const seen = new Set()
  const push = (value, source) => {
    if (!nonEmpty(value)) return
    const trimmed = value.trim()
    if (seen.has(trimmed)) return
    seen.add(trimmed)
    keys.push({ value: trimmed, source })
  }

  const credentials = safeGet(ctx, 'credentials')
  for (const name of COMMANDCODE_CREDENTIAL_NAMES) {
    try {
      const hit = await credentials?.resolve?.(name)
      push(hit?.value, name)
    } catch {
      // Fall through to the environment / credential document.
    }
  }
  for (const name of COMMANDCODE_CREDENTIAL_NAMES) push(env[name], name)
  for (const hit of await readCredentialFileValues(env, COMMANDCODE_CREDENTIAL_NAMES)) push(hit.value, hit.name)
  return keys
}

/**
 * Resolve the preferred CommandCode API key.
 *
 * @param {object} ctx - plugin context
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{value: string, source: string}|undefined>}
 */
export async function resolveCommandCodeApiKey(ctx, env = process.env) {
  const keys = await resolveCommandCodeApiKeys(ctx, env)
  if (keys.length > 0) return keys[0]
  // Keep the original shape for callers that only read `source`.
  return readCredentialFileValue(env, COMMANDCODE_CREDENTIAL_NAMES)
}

/**
 * Read one usage window: `used` of `cap` becomes a remaining percentage.
 *
 * @param {object|undefined} raw
 * @returns {{percent: number, resetsAt: number|undefined, exceeded: boolean}|undefined}
 */
function readWindow(raw) {
  if (!isRecord(raw)) return undefined
  const used = finiteNumber(raw.used)
  const cap = finiteNumber(raw.cap)
  if (used === undefined || cap === undefined || cap <= 0 || used < 0) return undefined
  const remaining = clampPercent(100 - (used / cap) * 100)
  const resetAt = finiteNumber(raw.resetAt)
  return {
    percent: remaining,
    resetsAt: resetAt !== undefined && resetAt > 0 ? resetAt : undefined,
    exceeded: raw.exceeded === true || used >= cap,
  }
}

/**
 * Parse `/alpha/billing/credits`.
 *
 * @param {object} payload
 * @returns {{fiveHourPercent?: number, weeklyPercent?: number, monthlyCredits?: number,
 *   monthlyCreditsGranted?: number, fiveHourResetsAt?: number, weeklyResetsAt?: number,
 *   limited: boolean, exceeded: boolean}|undefined}
 */
export function parseCommandCodeCredits(payload) {
  if (!isRecord(payload)) return undefined
  const limits = isRecord(payload.windowLimits) ? payload.windowLimits : undefined
  if (limits === undefined) return undefined
  const fiveHour = readWindow(limits.fiveHour)
  const weekly = readWindow(limits.weekly)
  if (fiveHour === undefined && weekly === undefined) return undefined
  const credits = isRecord(payload.credits) ? payload.credits : undefined
  const monthlyCredits = credits === undefined ? undefined : finiteNumber(credits.monthlyCredits)
  const monthlyCreditsGranted = credits === undefined ? undefined : finiteNumber(credits.monthlyCreditsGranted)
  return {
    fiveHourPercent: fiveHour?.percent,
    weeklyPercent: weekly?.percent,
    fiveHourResetsAt: fiveHour?.resetsAt,
    weeklyResetsAt: weekly?.resetsAt,
    monthlyCredits,
    monthlyCreditsGranted,
    limited: limits.limited === true,
    exceeded: fiveHour?.exceeded === true || weekly?.exceeded === true,
  }
}

/**
 * Query the CommandCode plan.
 *
 * @param {{value: string, source?: string}|undefined} credential
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, now?: number}} [options]
 */
export async function fetchCommandCodeQuota(credential, options = {}) {
  const now = options.now ?? Date.now()
  if (credential === undefined || !nonEmpty(credential.value)) {
    return { status: 'missing', message: '未配置 CommandCode API Key', fetchedAt: now }
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { status: 'error', message: 'fetch 不可用', fetchedAt: now }
  }
  const url = options.url ?? `${COMMANDCODE_ORIGIN}${COMMANDCODE_CREDITS_PATH}`
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${credential.value.trim()}`,
        accept: 'application/json',
        'cache-control': 'no-store',
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    })
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error)
    return {
      status: 'error',
      code: 'network',
      message: `CommandCode 额度查询失败: ${text}`.slice(0, 200),
      fetchedAt: now,
    }
  }

  if (response.status === 401 || response.status === 403) {
    return {
      status: 'error',
      code: 'auth',
      httpStatus: response.status,
      message: 'CommandCode 登录已失效',
      fetchedAt: now,
    }
  }
  if (!response.ok) {
    return {
      status: 'error',
      code: 'http',
      httpStatus: response.status,
      message: `CommandCode 额度查询失败: HTTP ${response.status}`,
      fetchedAt: now,
    }
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    return { status: 'error', code: 'parse', message: 'CommandCode 额度查询失败: 响应无法解析', fetchedAt: now }
  }
  const parsed = parseCommandCodeCredits(payload)
  if (parsed === undefined) {
    return {
      status: 'error',
      code: 'parse',
      message: 'CommandCode 额度查询失败: 响应缺少额度字段',
      fetchedAt: now,
    }
  }
  return { status: 'ok', ...parsed, fetchedAt: now }
}
