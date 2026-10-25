/**
 * Minimal, dependency-free client for the ChatGPT Codex usage endpoint.
 *
 * The endpoint is the same one the official Codex client uses. It needs an
 * account-scoped OAuth access token plus the ChatGPT account id; it returns
 * `used_percent` per rolling window, which this module converts to the
 * `remainingPercent` shape the status view consumes.
 */

import { USER_AGENT } from './version.js'

/** Fixed endpoint used by the official Codex client for ChatGPT rate limits. */
export const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'

const REQUEST_TIMEOUT_MS = 15_000

/** The stored OAuth session was rejected (expired or revoked). */
export class CodexAuthError extends Error {
  constructor(message = 'Codex OAuth session is no longer valid') {
    super(message)
    this.name = 'CodexAuthError'
    this.code = 'CODEX_AUTH_EXPIRED'
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function parseWindow(value) {
  if (!isRecord(value)) return undefined
  const used = value.used_percent
  const seconds = value.limit_window_seconds
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0 || used > 100) return undefined
  if (typeof seconds !== 'number' || !Number.isInteger(seconds) || seconds <= 0) return undefined
  const resetAt = typeof value.reset_at === 'number' && Number.isFinite(value.reset_at) && value.reset_at > 0
    ? value.reset_at
    : undefined
  return {
    remainingPercent: 100 - used,
    windowSeconds: seconds,
    ...(resetAt === undefined ? {} : { resetAt }),
  }
}

function parseLimit(id, name, value) {
  if (!isRecord(value)) return undefined
  const windows = [parseWindow(value.primary_window), parseWindow(value.secondary_window)]
    .filter(window => window !== undefined)
  if (windows.length === 0) return undefined
  return {
    id,
    ...(typeof name === 'string' && name.length > 0 ? { name } : {}),
    windows,
  }
}

function parseAmount(record, key) {
  const value = record[key]
  return typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value) ? value : undefined
}

/**
 * Project the opaque endpoint payload into secret-free display data.
 *
 * @param {unknown} value - parsed JSON from the usage endpoint
 * @returns {{rateLimits: Array<object>, credits?: object, individualLimit?: object}}
 */
export function parseCodexUsage(value) {
  if (!isRecord(value)) throw new Error('Codex returned a malformed usage response')

  const rateLimits = []
  const primary = parseLimit('codex', 'Codex', value.rate_limit)
  if (primary !== undefined) rateLimits.push(primary)

  const additional = value.additional_rate_limits
  if (Array.isArray(additional)) {
    for (const item of additional) {
      if (!isRecord(item)) continue
      const id = item.metered_feature
      const name = item.limit_name
      if (typeof id !== 'string' || id.length === 0) continue
      const limit = parseLimit(
        id,
        typeof name === 'string' && name.length > 0 ? name : undefined,
        item.rate_limit,
      )
      if (limit !== undefined) rateLimits.push(limit)
    }
  }

  const creditsValue = value.credits
  let credits
  if (isRecord(creditsValue) && creditsValue.has_credits === true) {
    credits = {
      unlimited: creditsValue.unlimited === true,
      ...(typeof creditsValue.balance === 'string' && creditsValue.balance.length > 0
        ? { balance: creditsValue.balance }
        : {}),
    }
  }

  const spend = value.spend_control
  const individual = isRecord(spend) && isRecord(spend.individual_limit)
    ? spend.individual_limit
    : undefined
  let individualLimit
  if (isRecord(individual)) {
    const limit = parseAmount(individual, 'limit')
    const used = parseAmount(individual, 'used')
    const remaining = parseAmount(individual, 'remaining')
    const percent = individual.remaining_percent
    if (limit !== undefined && used !== undefined && remaining !== undefined
      && typeof percent === 'number' && Number.isFinite(percent)) {
      individualLimit = {
        limit,
        used,
        remaining,
        remainingPercent: Math.max(0, Math.min(100, percent)),
      }
    }
  }

  return {
    rateLimits,
    ...(credits === undefined ? {} : { credits }),
    ...(individualLimit === undefined ? {} : { individualLimit }),
  }
}

/**
 * Fetch and parse the current Codex quota.
 *
 * @param {{accessToken: string, accountId: string}} credential
 * @param {typeof fetch} [fetchImpl] - injectable for tests
 * @returns {Promise<object>} usage projection
 * @throws {CodexAuthError} when the server rejects the OAuth session with 401
 */
export async function fetchCodexUsage(credential, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable')
  const response = await fetchImpl(CODEX_USAGE_URL, {
    method: 'GET',
    redirect: 'error',
    cache: 'no-store',
    headers: {
      authorization: `Bearer ${credential.accessToken}`,
      'chatgpt-account-id': credential.accountId,
      accept: 'application/json',
      'cache-control': 'no-store',
      'user-agent': USER_AGENT,
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (response.status === 401) throw new CodexAuthError()
  // 403 is deliberately not an auth verdict: Cloudflare and rate limits use
  // it too, and misreading one as "login expired" is worse than a retry.
  if (!response.ok) throw new Error(`Codex usage request failed with HTTP ${response.status}`)
  let payload
  try {
    payload = await response.json()
  } catch (error) {
    throw new Error('Codex returned an unreadable usage response', { cause: error })
  }
  return parseCodexUsage(payload)
}
