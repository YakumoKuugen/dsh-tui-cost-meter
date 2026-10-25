/**
 * MiniMax Token Plan quota — read-only.
 *
 * The endpoint is the one the MiniMax CLI and the dsh-cost-meter coding-plan
 * adapter use: `GET /v1/token_plan/remains` on the account's own domain
 * (`www.minimaxi.com` for CN accounts, `www.minimax.io` for the international
 * one). The response carries one row per model family with the remaining
 * percentage of the current 5-hour window and of the current week.
 *
 * Credentials come from the host credential service first, then the host
 * credential document, then the environment. Nothing is written anywhere and
 * the key never reaches a status line or an error message.
 */

import { readCredentialFileValue } from './credential-file.js'

/** Credential names in preference order, per account domain. */
export const MINIMAX_CREDENTIAL_NAMES = ['MINIMAX_CN_API_KEY', 'MINIMAX_API_KEY']

/** The CN account domain (minimax-cn provider). */
export const MINIMAX_CN_ORIGIN = 'https://www.minimaxi.com'

/** The international account domain (minimax provider). */
export const MINIMAX_INTERNATIONAL_ORIGIN = 'https://www.minimax.io'

/** Quota path on both domains. */
export const MINIMAX_QUOTA_PATH = '/v1/token_plan/remains'

/** Fallback origins tried when the primary domain refuses the key. */
export const MINIMAX_FALLBACK_ORIGINS = [
  'https://api.minimaxi.com',
  'https://api.minimax.io',
]

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
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

/**
 * The provider prefix of a provider id, so `minimax-cn` and `minimax` are
 * both recognised as MiniMax while `minimax-something-else` is not.
 *
 * @param {string|undefined} provider
 * @returns {boolean}
 */
export function isMiniMaxProvider(provider) {
  if (typeof provider !== 'string') return false
  const id = provider.toLowerCase()
  return id === 'minimax' || id === 'minimax-cn' || id.startsWith('minimax-')
}

/**
 * Resolve a MiniMax API key.
 *
 * @param {object} ctx - plugin context
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{value: string, source: string}|undefined>}
 */
export async function resolveMiniMaxApiKey(ctx, env = process.env) {
  const credentials = safeGet(ctx, 'credentials')
  for (const name of MINIMAX_CREDENTIAL_NAMES) {
    try {
      const hit = await credentials?.resolve?.(name)
      if (nonEmpty(hit?.value)) return { value: hit.value.trim(), source: name }
    } catch {
      // Fall through to the environment / credential document.
    }
    if (nonEmpty(env[name])) return { value: env[name].trim(), source: name }
  }
  const fileValue = await readCredentialFileValue(env, MINIMAX_CREDENTIAL_NAMES)
  if (fileValue !== undefined) return fileValue
  return undefined
}

/**
 * Read one quota row.
 *
 * The `model_remains` array is the current shape; a flat object carrying the
 * same fields is accepted as well because older plans answer that way.
 *
 * @param {object} payload
 * @param {string} [model] - the model whose row should be preferred
 * @returns {{model: string|undefined, intervalPercent: number|undefined, weeklyPercent: number|undefined, intervalUnlimited: boolean, weeklyUnlimited: boolean}|undefined}
 */
export function parseMiniMaxRemains(payload, model) {
  const root = isRecord(payload) && isRecord(payload.data) ? payload.data : payload
  if (!isRecord(root)) return undefined
  const rows = Array.isArray(root.model_remains)
    ? root.model_remains
    : Array.isArray(payload?.model_remains)
      ? payload.model_remains
      : undefined

  const row = rows === undefined
    ? root
    : pickRow(rows, model)
  if (!isRecord(row)) return undefined

  const intervalStatus = finiteNumber(row.current_interval_status)
  const weeklyStatus = finiteNumber(row.current_weekly_status)
  const intervalPercent = clampPercent(row.current_interval_remaining_percent)
  const weeklyPercent = clampPercent(row.current_weekly_remaining_percent)
  if (intervalPercent === undefined && weeklyPercent === undefined
    && intervalStatus !== 3 && weeklyStatus !== 3) {
    return undefined
  }
  return {
    model: typeof row.model_name === 'string' && row.model_name.length > 0 ? row.model_name : undefined,
    intervalPercent,
    weeklyPercent,
    intervalUnlimited: intervalStatus === 3,
    weeklyUnlimited: weeklyStatus === 3,
  }
}

/**
 * The row of a plan.
 *
 * The API returns one row per model family plus a shared `general` row. A row
 * named after the model in use is the most specific answer, so it wins over
 * `general`; without such a row the shared `general` row is the plan's own
 * aggregate and is used instead.
 *
 * @param {object[]} rows
 * @param {string|undefined} model
 */
function pickRow(rows, model) {
  const wanted = typeof model === 'string' ? model.toLowerCase() : undefined
  if (wanted !== undefined) {
    const exact = rows.find(row => isRecord(row) && String(row.model_name ?? '').toLowerCase() === wanted)
    if (exact !== undefined) return exact
  }
  const general = rows.find(row => isRecord(row) && String(row.model_name ?? '').toLowerCase() === 'general')
  const withPercent = rows.find(row => isRecord(row)
    && (finiteNumber(row.current_interval_remaining_percent) !== undefined
      || finiteNumber(row.current_weekly_remaining_percent) !== undefined))
  const specific = rows.find(row => isRecord(row)
    && String(row.model_name ?? '').toLowerCase() !== 'general'
    && (finiteNumber(row.current_interval_remaining_percent) !== undefined
      || finiteNumber(row.current_weekly_remaining_percent) !== undefined))
  if (wanted !== undefined && specific !== undefined) return specific
  if (general !== undefined) return general
  return withPercent ?? rows.find(row => isRecord(row))
}

/**
 * Query the Token Plan quota.
 *
 * @param {{value: string, source?: string}|undefined} credential
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, now?: number, model?: string, origins?: string[]}} [options]
 */
export async function fetchMiniMaxQuota(credential, options = {}) {
  const now = options.now ?? Date.now()
  if (credential === undefined || !nonEmpty(credential.value)) {
    return { status: 'missing', message: '未配置 MiniMax API Key', fetchedAt: now }
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') {
    return { status: 'error', message: 'fetch 不可用', fetchedAt: now }
  }
  const origins = options.origins ?? [MINIMAX_CN_ORIGIN, MINIMAX_INTERNATIONAL_ORIGIN]
  let lastError = '未知错误'

  for (const origin of origins) {
    const url = `${origin}${MINIMAX_QUOTA_PATH}`
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
          'user-agent': 'dsh-tui-cost-meter/0.3 (DeepSeek Harness plugin)',
        },
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      })
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
      continue
    }

    if (response.status === 401 || response.status === 403) {
      // The two domains do not share keys; try the next origin.
      lastError = `HTTP ${response.status}`
      continue
    }
    if (!response.ok) {
      lastError = `HTTP ${response.status}`
      continue
    }
    let payload
    try {
      payload = await response.json()
    } catch {
      lastError = '响应无法解析'
      continue
    }
    const parsed = parseMiniMaxRemains(payload, options.model)
    if (parsed === undefined) {
      lastError = '响应缺少额度字段'
      continue
    }
    return { status: 'ok', ...parsed, fetchedAt: now, origin }
  }
  return { status: 'error', message: `MiniMax 额度查询失败: ${lastError}`, fetchedAt: now }
}
