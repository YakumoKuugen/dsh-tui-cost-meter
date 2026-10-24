/**
 * Read-only Codex credential discovery.
 *
 * A dsh-tui Codex session gets its ChatGPT OAuth token from one of three
 * places. The quota line must work with every one of them, and it must never
 * write a token:
 *
 * 1. `$DSH_HOME/dsh-auth/credentials.json` — dsh-tui's OAuth store (the
 *    native Codex backend reads this).
 * 2. `$DSH_HOME/.openai-codex-auth.json` — the dsh-codex plugin's store.
 * 3. `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) — the official
 *    Codex CLI's own OAuth tokens, when it stores `tokens` instead of an API
 *    key.
 *
 * API-key files are deliberately ignored: the ChatGPT usage endpoint needs an
 * account-scoped OAuth token, not a bearer API key.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Provider id used by dsh-auth for the ChatGPT subscription. */
export const CODEX_OAUTH_PROVIDER = 'openai-codex'

/** Resolve `$DSH_HOME`, matching `@deepseek-ai/dsh-home-paths`. */
export function resolveDshHome(env = process.env) {
  const configured = env.DSH_HOME
  return configured !== undefined && configured.trim() !== ''
    ? configured
    : join(homedir(), '.dsh')
}

/** Resolve the official Codex CLI home. */
export function resolveCodexHome(env = process.env) {
  const configured = env.CODEX_HOME
  return configured !== undefined && configured.trim() !== ''
    ? configured
    : join(homedir(), '.codex')
}

/**
 * Every credential document this plugin understands, in preference order.
 * Kept separate from {@link readCredentialCandidates} so diagnostics and the
 * README can name the exact paths without duplicating them.
 */
export function credentialPaths(env = process.env) {
  const dshHome = resolveDshHome(env)
  return {
    dshAuth: join(dshHome, 'dsh-auth', 'credentials.json'),
    dshCodex: join(dshHome, '.openai-codex-auth.json'),
    nativeCodex: join(resolveCodexHome(env), 'auth.json'),
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Decode only our own token payload; signature verification belongs to the server. */
export function decodeTokenClaims(token) {
  if (typeof token !== 'string') return undefined
  const parts = token.split('.')
  if (parts.length !== 3) return undefined
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'))
    if (!isRecord(payload)) return undefined
    const auth = isRecord(payload['https://api.openai.com/auth'])
      ? payload['https://api.openai.com/auth']
      : undefined
    const accountId = typeof auth?.chatgpt_account_id === 'string'
      ? auth.chatgpt_account_id
      : undefined
    const expiresAt = typeof payload.exp === 'number' && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : undefined
    return {
      ...(accountId === undefined || accountId.length === 0 ? {} : { accountId }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
    }
  } catch {
    return undefined
  }
}

function normalize(source, accessToken, accountId, expiresAt) {
  if (typeof accessToken !== 'string' || accessToken.length === 0) return undefined
  const claims = decodeTokenClaims(accessToken)
  const id = typeof accountId === 'string' && accountId.length > 0
    ? accountId
    : claims?.accountId
  if (id === undefined || id.length === 0) return undefined
  const expiry = typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt > 0
    ? expiresAt
    : claims?.expiresAt
  return {
    source,
    accessToken,
    accountId: id,
    ...(expiry === undefined ? {} : { expiresAt: expiry }),
    expired: expiry !== undefined && expiry <= Date.now() + 60_000,
  }
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * Read every usable OAuth candidate. Malformed or absent documents are
 * skipped: a quota line is decorative, never a reason to fail startup.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<Array<{source: string, accessToken: string, accountId: string, expiresAt?: number, expired: boolean}>>}
 */
export async function readCredentialCandidates(env = process.env) {
  const paths = credentialPaths(env)
  const candidates = []

  const auth = await readJson(paths.dshAuth)
  const stored = isRecord(auth) && isRecord(auth.providers)
    ? auth.providers[CODEX_OAUTH_PROVIDER]
    : undefined
  if (isRecord(stored) && stored.type === 'oauth') {
    const candidate = normalize('dsh-auth', stored.access, stored.accountId, stored.expires)
    if (candidate !== undefined) candidates.push(candidate)
  }

  const codex = await readJson(paths.dshCodex)
  const own = isRecord(codex) && isRecord(codex.credential) ? codex.credential : undefined
  if (isRecord(own) && own.type === 'oauth') {
    const candidate = normalize('dsh-codex', own.access, own.accountId, own.expires)
    if (candidate !== undefined) candidates.push(candidate)
  }

  const native = await readJson(paths.nativeCodex)
  const tokens = isRecord(native) && isRecord(native.tokens) ? native.tokens : undefined
  if (tokens !== undefined) {
    const candidate = normalize(
      'codex-cli',
      tokens.access_token,
      tokens.account_id,
      typeof tokens.expires_at === 'number' ? tokens.expires_at : undefined,
    )
    if (candidate !== undefined) candidates.push(candidate)
  }

  return candidates.sort((left, right) => (right.expiresAt ?? 0) - (left.expiresAt ?? 0))
}

/**
 * Best candidate: a live token first, then the newest expired one so the UI
 * can say "login expired" instead of "not signed in".
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<object|undefined>}
 */
export async function readBestCredential(env = process.env) {
  const candidates = await readCredentialCandidates(env)
  return candidates.find(candidate => candidate.expired !== true) ?? candidates[0]
}
