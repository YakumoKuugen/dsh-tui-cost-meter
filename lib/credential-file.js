import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Minimal readers for the host credential document.
 *
 * The host keeps `$DSH_HOME/.credentials.yaml` with two blocks: `refs`
 * (environment-variable style secrets) and `records` (account grants). Plugins
 * read it directly only when the credential service is absent, and only these
 * two blocks — the parser is intentionally a strict subset of YAML rather than
 * a general one, so a malformed document can never silently change meaning.
 */

/** Path of the host credential document. */
export function credentialsFilePath(env = process.env) {
  const home = env.DSH_HOME !== undefined && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME
    : join(homedir(), '.dsh')
  return join(home, '.credentials.yaml')
}

/**
 * Parse the `refs:` block of a credential document.
 *
 * @param {string} text - raw document text
 * @returns {Record<string, string>} ref name → value
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
 * Parse the `records:` block of a credential document.
 *
 * @param {string} text - raw document text
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
 * Read the first of the named refs from the credential document.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string[]} names - ref names in preference order
 * @returns {Promise<{value: string, source: string}|undefined>}
 */
export async function readCredentialFileValue(env, names) {
  try {
    const refs = parseCredentialRefs(await readFile(credentialsFilePath(env), 'utf8'))
    for (const name of names) {
      if (typeof refs[name] === 'string' && refs[name].trim().length > 0) {
        return { value: refs[name].trim(), source: 'credentials-file' }
      }
    }
  } catch {
    // Missing/unreadable file: the caller still has env/settings fallbacks.
  }
  return undefined
}
