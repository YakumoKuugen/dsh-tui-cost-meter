/**
 * Read-only DeepSeek facts for the second status line.
 *
 * Two independent sources:
 *  - the dsh-cost-meter ledger, for every recorded DeepSeek official-channel
 *    call (today + retained history);
 *  - the official open-platform balance endpoint, using the same
 *    `DEEPSEEK_BALANCE_API_KEY` / `DEEPSEEK_API_KEY` credential the cost meter
 *    uses.
 *
 * Nothing here writes either file or credential store, and no key is ever
 * returned in a status/error string.
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

import { resolveDshHome } from './credentials.js'
import {
  DEFAULT_PEAK_EFFECTIVE_AT,
  DEFAULT_PEAK_WINDOWS,
  localDayKey,
  peakConfigOf,
  sumDeepSeekCost,
} from './deepseek.js'

/** Official open-platform balance endpoint. */
export const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance'

/** Path of dsh-cost-meter's ledger (`$DSH_HOME/storages/cost-meter/ledger.json`). */
export function costMeterLedgerPath(env = process.env) {
  return join(resolveDshHome(env), 'storages', 'cost-meter', 'ledger.json')
}

/** Path of the host's credential document. */
export function credentialsFilePath(env = process.env) {
  return join(resolveDshHome(env), '.credentials.yaml')
}

/**
 * Minimal parser for the `refs:` scalar block of `.credentials.yaml`.
 *
 * The host's credentials service is the preferred source. Some TUI profiles
 * do not mount it, but the same document is still on disk and contains the
 * ref -> value map this plugin needs. Only the refs block is read; records and
 * account tokens are ignored.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseCredentialRefs(text) {
  const refs = {}
  if (typeof text !== 'string') return refs
  let inRefs = false
  for (const line of text.split(/\r?\n/u)) {
    if (/^refs:\s*$/u.test(line)) {
      inRefs = true
      continue
    }
    if (!inRefs) continue
    if (/^\S/u.test(line)) break
    const match = /^\s{2}([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/u.exec(line)
    if (match === null) continue
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value.length > 0) refs[match[1]] = value
  }
  return refs
}

/**
 * Minimal indentation parser for the `records:` block of the host credential
 * document. The platform grant is stored as
 * `records['deepseek-account-platform/default'].payload.token`; parsing only
 * this block avoids depending on a YAML package at runtime.
 *
 * @param {string} text
 * @returns {{records: Record<string, any>}}
 */
export function parseCredentialRecords(text) {
  const records = {}
  if (typeof text !== 'string') return { records }
  const stack = [{ indent: -1, node: records }]
  let inRecords = false
  for (const line of text.split(/\r?\n/u)) {
    if (!inRecords) {
      if (/^records:\s*$/u.test(line)) inRecords = true
      continue
    }
    if (/^\S/u.test(line)) break
    const match = /^(\s+)([A-Za-z0-9_./-]+):\s*(.*)$/u.exec(line)
    if (match === null) continue
    const indent = match[1].length
    while (stack.length > 1 && stack[stack.length - 1].indent >= indent) stack.pop()
    const parent = stack[stack.length - 1].node
    const key = match[2]
    let value = match[3].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value === '') {
      const child = {}
      parent[key] = child
      stack.push({ indent, node: child })
    } else {
      parent[key] = value
    }
  }
  return { records }
}

/**
 * Read the signed-in Platform grant without exposing it to the caller's
 * status/error strings. Uses the credential service when mounted, then the
 * same on-disk document as the balance fallback.
 *
 * @param {object} ctx
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{token: string, issuer?: string}|undefined>}
 */
export async function readPlatformGrant(ctx, env = process.env) {
  const recordKey = 'deepseek-account-platform/default'
  const credentials = safeGet(ctx, 'credentials')
  try {
    const record = await credentials?.readRecord?.(recordKey)
    const payload = record?.payload
    if (record?.kind === 'grant' && isRecord(payload) && nonEmpty(payload.token)) {
      return {
        token: payload.token,
        ...(typeof payload.issuer === 'string' ? { issuer: payload.issuer } : {}),
      }
    }
  } catch (error) {
  }
  try {
    const parsed = parseCredentialRecords(await readFile(credentialsFilePath(env), 'utf8'))
    const record = parsed.records?.[recordKey]
    const payload = record?.payload
    if (record?.kind === 'grant' && isRecord(payload) && nonEmpty(payload.token)) {
      return {
        token: payload.token,
        ...(typeof payload.issuer === 'string' ? { issuer: payload.issuer } : {}),
      }
    }
  } catch (error) {
  }
  return undefined
}

/**
 * Parse `/api/v0/usage/by_api_key/cost`'s `biz_data` for the current month.
 * The endpoint returns one currency group with daily buckets per API key.
 *
 * @param {object} payload
 * @param {number} [now]
 */
export function parsePlatformUsagePayload(payload, now = Date.now()) {
  const groups = Array.isArray(payload?.data) ? payload.data : []
  const group = groups.find(entry => isRecord(entry) && entry.currency === 'CNY')
    ?? groups.find(entry => isRecord(entry))
  if (group === undefined) {
    return { status: 'ok', currency: 'CNY', month: 0, today: 0, fetchedAt: now }
  }
  const date = new Date(now)
  const todayStart = Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime() / 1000)
  let month = 0
  let today = 0
  for (const series of Array.isArray(group.series) ? group.series : []) {
    for (const bucket of Array.isArray(series?.buckets) ? series.buckets : []) {
      const cost = finiteNumber(bucket?.cost)
      if (cost === undefined) continue
      month += cost
      const rawTime = finiteNumber(bucket?.time)
      if (rawTime === undefined) continue
      const time = rawTime > 1e12 ? Math.floor(rawTime / 1000) : rawTime
      if (time === todayStart) today += cost
    }
  }
  return {
    status: 'ok',
    currency: typeof group.currency === 'string' && group.currency.length > 0 ? group.currency : 'CNY',
    month,
    today,
    fetchedAt: now,
  }
}

/**
 * Fetch this month's Platform usage cost with the signed-in account grant.
 * The range must be day-aligned; the endpoint rejects an arbitrary "now"
 * timestamp with INVALID_PARAM.
 *
 * @param {{token: string, issuer?: string}|undefined} grant
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, now?: number}} [options]
 */
export async function fetchDeepSeekPlatformUsage(grant, options = {}) {
  const now = options.now ?? Date.now()
  if (grant === undefined || !nonEmpty(grant.token)) {
    return { status: 'missing', message: '未登录 DeepSeek 平台账号', fetchedAt: now }
  }
  let origin = 'https://platform.deepseek.com'
  try {
    const url = new URL(grant.issuer ?? origin)
    if (url.protocol !== 'https:' || url.host !== 'platform.deepseek.com'
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== '' && url.pathname !== '/')) {
      return { status: 'error', message: 'DeepSeek 账号 issuer 非官方地址', fetchedAt: now }
    }
    origin = `${url.protocol}//${url.host}`
  } catch {
    return { status: 'error', message: 'DeepSeek 账号 issuer 无效', fetchedAt: now }
  }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { status: 'error', message: 'fetch 不可用', fetchedAt: now }

  const date = new Date(now)
  const start = Math.floor(new Date(date.getFullYear(), date.getMonth(), 1).getTime() / 1000)
  const end = Math.floor(new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime() / 1000)
  const tz = -date.getTimezoneOffset() * 60
  const url = `${origin}/api/v0/usage/by_api_key/cost?start=${start}&end=${end}&tz=${tz}`
  let response
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        'x-dsh-auth-token': grant.token,
        'x-client-platform': 'web',
        'x-client-version': '',
        'x-client-locale': 'zh_CN',
        'x-client-timezone-offset': String(tz),
        'x-client-bundle-id': '',
        accept: 'application/json',
        'cache-control': 'no-store',
        'user-agent': 'dsh-tui-cost-meter',
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    })
  } catch (error) {
    return { status: 'error', message: `本月费用请求失败: ${error instanceof Error ? error.message : String(error)}`, fetchedAt: now }
  }
  if (response.status === 401 || response.status === 403) {
    return { status: 'unauthorized', message: 'DeepSeek 平台账号未授权', fetchedAt: now }
  }
  if (!response.ok) {
    return { status: 'error', message: `本月费用接口 HTTP ${response.status}`, fetchedAt: now }
  }
  let body
  try {
    body = await response.json()
  } catch {
    return { status: 'error', message: '本月费用响应无法解析', fetchedAt: now }
  }
  if (body?.data?.biz_code !== 0) {
    return {
      status: 'error',
      message: `本月费用接口返回 ${body?.data?.biz_code ?? 'unknown'} ${body?.data?.biz_msg ?? ''}`.trim(),
      fetchedAt: now,
    }
  }
  return parsePlatformUsagePayload(body.data.biz_data, now)
}

/** Resolve the platform grant and fetch this month's cost in one call. */
export async function readDeepSeekPlatformUsage(ctx, env = process.env, options = {}) {
  const grant = await readPlatformGrant(ctx, env)
  const result = await fetchDeepSeekPlatformUsage(grant, options)
  return result
}

/** Read one of the named refs from `$DSH_HOME/.credentials.yaml`, if present. */
export async function readCredentialFileValue(env, names) {
  try {
    const refs = parseCredentialRefs(await readFile(credentialsFilePath(env), 'utf8'))
    for (const name of names) {
      if (nonEmpty(refs[name])) return { value: refs[name].trim(), source: 'credentials-file' }
    }
  } catch {
    // Missing/unreadable file: the caller still has env/settings fallbacks.
  }
  return undefined
}


function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function finiteNumber(value) {
  const number = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(number) ? number : undefined
}

function moneyOf(part, fallbackCurrency) {
  if (part?.cny !== undefined) return { cny: part.cny, currency: 'CNY' }
  if (part?.usd !== undefined) return { usd: part.usd, currency: 'USD' }
  return fallbackCurrency === 'USD' ? { usd: 0, currency: 'USD' } : { cny: 0, currency: 'CNY' }
}

function addMoney(target, part, fallbackCurrency) {
  const money = moneyOf(part, fallbackCurrency)
  if (money.cny !== undefined) {
    target.cny = (target.cny ?? 0) + money.cny
    target.hasCny = true
  } else {
    target.usd = (target.usd ?? 0) + money.usd
    target.hasUsd = true
  }
}

/**
 * Project a dsh-cost-meter ledger document into compact DeepSeek totals.
 *
 * @param {object} doc - parsed `ledger.json`
 * @param {number} [now] - epoch ms, for the "today" bucket
 * @returns {object}
 */
export function projectCostMeterLedger(doc, now = Date.now()) {
  if (!isRecord(doc)) throw new Error('cost-meter ledger is not an object')
  const config = isRecord(doc.config) ? doc.config : {}
  const days = isRecord(doc.days) ? doc.days : {}
  const total = { cny: 0, usd: 0, hasCny: false, hasUsd: false, calls: 0 }
  const month = { cny: 0, usd: 0, hasCny: false, hasUsd: false, calls: 0 }
  const monthKey = localDayKey(now).slice(0, 7)

  for (const [key, day] of Object.entries(days)) {
    if (!isRecord(day)) continue
    const part = sumDeepSeekCost(day, config)
    addMoney(total, part, config.currency === 'USD' ? 'USD' : 'CNY')
    total.calls += part.calls
    if (key.startsWith(monthKey)) {
      addMoney(month, part, config.currency === 'USD' ? 'USD' : 'CNY')
      month.calls += part.calls
    }
  }

  const todayPart = sumDeepSeekCost(days[localDayKey(now)], config)
  const today = { cny: 0, usd: 0, hasCny: false, hasUsd: false, calls: 0 }
  addMoney(today, todayPart, config.currency === 'USD' ? 'USD' : 'CNY')
  today.calls += todayPart.calls

  return {
    present: true,
    total: {
      ...(total.hasCny ? { cny: total.cny } : {}),
      ...(total.hasUsd ? { usd: total.usd } : {}),
      currency: total.hasCny ? 'CNY' : total.hasUsd ? 'USD' : config.currency === 'USD' ? 'USD' : 'CNY',
      calls: total.calls,
    },
    today: {
      ...(today.hasCny ? { cny: today.cny } : {}),
      ...(today.hasUsd ? { usd: today.usd } : {}),
      currency: today.hasCny ? 'CNY' : today.hasUsd ? 'USD' : config.currency === 'USD' ? 'USD' : 'CNY',
      calls: today.calls,
    },
    month: {
      ...(month.hasCny ? { cny: month.cny } : {}),
      ...(month.hasUsd ? { usd: month.usd } : {}),
      currency: month.hasCny ? 'CNY' : month.hasUsd ? 'USD' : config.currency === 'USD' ? 'USD' : 'CNY',
      calls: month.calls,
    },
    peakConfig: peakConfigOf(config),
    currency: config.currency === 'USD' ? 'USD' : 'CNY',
    updatedAt: now,
  }
}

/**
 * Read and project the cost-meter ledger. A missing ledger is not an error:
 * the balance line can still work before the first call is recorded.
 *
 * @param {{path?: string, now?: number}} [options]
 */
export async function readCostMeterLedger(options = {}) {
  const path = options.path ?? costMeterLedgerPath()
  const now = options.now ?? Date.now()
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        present: false,
        total: undefined,
        month: undefined,
        today: undefined,
        peakConfig: peakConfigOf({}),
        currency: 'CNY',
        updatedAt: now,
      }
    }
    throw error
  }
  return projectCostMeterLedger(JSON.parse(text), now)
}

function officialBaseUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return true
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.host === 'api.deepseek.com'
      && !url.username && !url.password && !url.search && !url.hash
      && (url.pathname === '' || url.pathname === '/')
  } catch {
    return false
  }
}

function safeGet(ctx, name) {
  try {
    return ctx?.get?.(name)
  } catch {
    return undefined
  }
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0
}

/**
 * Resolve the open-platform key. Dedicated balance key first, then the normal
 * DeepSeek inference key, then the `llm-deepseek` setting's `apiKeyEnv`.
 * A non-official custom base URL never receives the key.
 *
 * @param {object} ctx - plugin context
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{value: string, source: string}|undefined>}
 */
export async function resolveDeepSeekApiKey(ctx, env = process.env) {
  const credentials = safeGet(ctx, 'credentials')
  for (const name of ['DEEPSEEK_BALANCE_API_KEY', 'DEEPSEEK_API_KEY']) {
    try {
      const hit = await credentials?.resolve?.(name)
      if (nonEmpty(hit?.value)) return { value: hit.value.trim(), source: name }
    } catch {
      // Fall back to the environment / settings source below.
    }
    if (nonEmpty(env[name])) return { value: env[name].trim(), source: name }
  }

  const fileValue = await readCredentialFileValue(env, ['DEEPSEEK_BALANCE_API_KEY', 'DEEPSEEK_API_KEY'])
  if (fileValue !== undefined) return fileValue

  try {
    const section = safeGet(ctx, 'settings')?.get?.('llm-deepseek')
    const name = section?.apiKeyEnv
    if (officialBaseUrl(section?.baseURL) && typeof name === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      try {
        const hit = await credentials?.resolve?.(name)
        if (nonEmpty(hit?.value)) return { value: hit.value.trim(), source: name }
      } catch {
        // The environment is the final fallback.
      }
      if (nonEmpty(env[name])) return { value: env[name].trim(), source: name }
      const sectionFileValue = await readCredentialFileValue(env, [name])
      if (sectionFileValue !== undefined) return sectionFileValue
    }
  } catch {
    // An older host may not expose the settings service; the two key names
    // above are still enough for the common case.
  }

  return undefined
}

function pickBalanceInfoFromList(infos) {
  const list = Array.isArray(infos) ? infos : []
  return list.find(info => isRecord(info) && info.currency === 'CNY')
    ?? list.find(info => isRecord(info))
}

function pickBalanceInfo(payload) {
  return pickBalanceInfoFromList(payload?.balance_infos)
}

function accountWalletGroup(list) {
  if (!Array.isArray(list)) return null
  const wallets = []
  for (const entry of list) {
    if (!isRecord(entry) || !['CNY', 'USD'].includes(String(entry.currency).toUpperCase())) return null
    const amount = finiteNumber(entry.balance)
    if (amount === undefined) return null
    wallets.push({ currency: String(entry.currency).toUpperCase(), amount })
  }
  return wallets
}

/**
 * Read the signed-in DSH account wallet, when the host exposes it.
 *
 * This is the same source the desktop account page uses; it does not need an
 * open-platform API key and never exposes the wallet token. Returns undefined
 * when the host has no account service, and a status object otherwise.
 *
 * @param {object} ctx - plugin context
 * @param {number} [now]
 */
export async function readDeepSeekAccountBalance(ctx, now = Date.now()) {
  const account = safeGet(ctx, 'deepseekAccount')
  if (typeof account?.getBalance !== 'function') return undefined
  let details
  try {
    details = await account.getBalance({
      version: '',
      locale: 'zh',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    })
  } catch {
    return { status: 'error', message: '账号余额查询失败', fetchedAt: now, source: 'account' }
  }
  if (details === null) {
    return { status: 'missing', message: '未登录 DeepSeek 账号', fetchedAt: now, source: 'account' }
  }
  if (details.status !== undefined && details.status !== 'ready') {
    return { status: 'unavailable', message: '账号余额不可用', fetchedAt: now, source: 'account' }
  }
  const normal = accountWalletGroup(details.value)
  const bonus = accountWalletGroup(details.bonusWallets)
  if (normal === null || bonus === null) {
    return { status: 'error', message: '账号余额响应格式无效', fetchedAt: now, source: 'account' }
  }
  const totals = new Map()
  for (const wallet of [...normal, ...bonus]) {
    totals.set(wallet.currency, (totals.get(wallet.currency) ?? 0) + wallet.amount)
  }
  const picked = pickBalanceInfoFromList([...totals].map(([currency, total]) => ({ currency, total_balance: total })))
  if (picked === undefined) {
    return { status: 'error', message: '账号钱包为空', fetchedAt: now, source: 'account' }
  }
  const currency = picked.currency
  const sumOf = group => group.reduce((sum, wallet) => wallet.currency === currency ? sum + wallet.amount : sum, 0)
  const total = sumOf(normal) + sumOf(bonus)
  if (!Number.isFinite(total)) {
    return { status: 'error', message: '账号余额金额无效', fetchedAt: now, source: 'account' }
  }
  return {
    status: 'ok',
    currency,
    total,
    granted: sumOf(bonus),
    topped: sumOf(normal),
    fetchedAt: now,
    source: 'account',
  }
}

/**
 * Parse the official balance response. Exported for tests; never logs raw
 * payload/credential material.
 *
 * @param {object} payload
 * @param {number} [now]
 * @returns {object}
 */
export function parseDeepSeekBalance(payload, now = Date.now()) {
  if (!isRecord(payload)) return { status: 'error', message: '余额响应不是对象', fetchedAt: now }
  if (payload.is_available === false) {
    return { status: 'unavailable', message: '账户余额不可用', fetchedAt: now }
  }
  const info = pickBalanceInfo(payload)
  if (!isRecord(info)) return { status: 'error', message: '余额响应缺少 balance_infos', fetchedAt: now }
  const total = finiteNumber(info.total_balance)
  if (total === undefined) return { status: 'error', message: '余额响应缺少 total_balance', fetchedAt: now }
  const granted = finiteNumber(info.granted_balance)
  const topped = finiteNumber(info.topped_up_balance)
  return {
    status: 'ok',
    currency: typeof info.currency === 'string' && info.currency.length > 0 ? info.currency : 'CNY',
    total,
    ...(granted === undefined ? {} : { granted }),
    ...(topped === undefined ? {} : { topped }),
    fetchedAt: now,
  }
}

/**
 * Query the official open-platform balance.
 *
 * @param {string|undefined} apiKey
 * @param {{fetchImpl?: typeof fetch, timeoutMs?: number, now?: number}} [options]
 */
export async function fetchDeepSeekBalance(apiKey, options = {}) {
  const now = options.now ?? Date.now()
  if (!nonEmpty(apiKey)) return { status: 'missing', message: '未配置 DeepSeek API Key', fetchedAt: now }
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { status: 'error', message: 'fetch 不可用', fetchedAt: now }

  let response
  try {
    response = await fetchImpl(DEEPSEEK_BALANCE_URL, {
      method: 'GET',
      redirect: 'error',
      cache: 'no-store',
      headers: {
        authorization: `Bearer ${apiKey}`,
        accept: 'application/json',
        'cache-control': 'no-store',
        'user-agent': 'dsh-tui-cost-meter',
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    })
  } catch (error) {
    return { status: 'error', message: `余额请求失败: ${error instanceof Error ? error.message : String(error)}`, fetchedAt: now }
  }

  if (response.status === 401 || response.status === 403) {
    return { status: 'unauthorized', message: 'DeepSeek API Key 未授权余额查询', fetchedAt: now }
  }
  if (!response.ok) {
    return { status: 'error', message: `余额接口 HTTP ${response.status}`, fetchedAt: now }
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    return { status: 'error', message: '余额响应无法解析', fetchedAt: now }
  }
  return parseDeepSeekBalance(payload, now)
}

/** Exported for diagnostics/tests; keeps the default schedule readable. */
export const DEEPSEEK_PEAK_DEFAULTS = {
  windows: DEFAULT_PEAK_WINDOWS,
  effectiveAtMs: DEFAULT_PEAK_EFFECTIVE_AT,
}
