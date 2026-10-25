/**
 * Which provider the current session actually talks to.
 *
 * The status row shows one billing module at a time: the Codex quota line
 * while a Codex model is selected, the MiniMax Token Plan line while a
 * MiniMax model is selected, and the DeepSeek cost line for DeepSeek.
 *
 * The route is read from the host's own model preference
 * (`~/.dsh-tui/model.json`), because that is the file dsh-tui writes on every
 * `/model` switch and the file it reads on startup. It is a read-only view of
 * a user preference — the plugin never writes it.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Provider families the plugin recognises. */
export const PROVIDER_FAMILIES = Object.freeze({
  CODEX: 'codex',
  MINIMAX: 'minimax',
  DEEPSEEK: 'deepseek',
})

/** Path of the host's persisted model preference. */
export function modelPrefPath(env = process.env) {
  const home = env.DSH_TUI_HOME !== undefined && env.DSH_TUI_HOME.trim() !== ''
    ? env.DSH_TUI_HOME
    : join(homedir(), '.dsh-tui')
  return join(home, 'model.json')
}

/**
 * Parse the persisted `{ provider, model }` preference.
 *
 * @param {string} text
 * @returns {{provider: string, model: string}|undefined}
 */
export function parseModelPref(text) {
  if (typeof text !== 'string') return undefined
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const { provider, model } = parsed
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

/**
 * Read the persisted model preference.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{provider: string, model: string}|undefined>}
 */
export async function readModelPref(env = process.env) {
  try {
    return parseModelPref(await readFile(modelPrefPath(env), 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * The billing family a provider id belongs to.
 *
 * @param {string|undefined} provider
 * @returns {'codex'|'minimax'|'deepseek'|undefined}
 */
export function familyOfProvider(provider) {
  if (typeof provider !== 'string') return undefined
  // dsh registers model providers under an `llm-` prefix on some routes.
  const id = provider.toLowerCase().replace(/^llm-/, '')
  if (id === 'openai-codex' || id === 'codex' || id.startsWith('openai-codex')) {
    return PROVIDER_FAMILIES.CODEX
  }
  if (id === 'minimax' || id === 'minimax-cn' || id.startsWith('minimax-')) {
    return PROVIDER_FAMILIES.MINIMAX
  }
  if (id === 'deepseek' || id.startsWith('deepseek-') || id.endsWith('-deepseek')) {
    return PROVIDER_FAMILIES.DEEPSEEK
  }
  return undefined
}

/**
 * Read the current route and classify it.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Promise<{provider: string, model: string, family: string|undefined}|undefined>}
 */
export async function readActiveRoute(env = process.env) {
  const pref = await readModelPref(env)
  if (pref === undefined) return undefined
  return { ...pref, family: familyOfProvider(pref.provider) }
}

/**
 * Whether a billing family belongs to the model in use.
 *
 * An unknown route (no persisted preference yet) keeps every module visible:
 * hiding everything would leave the user with no cost information at all.
 *
 * @param {{family: string|undefined}|undefined} active
 * @param {string} family
 * @returns {boolean}
 */
export function isFamilyActive(active, family) {
  if (active === undefined || active === null) return true
  if (active.family === undefined) return true
  return active.family === family
}

/** Live route state plus its own refresh loop. */
export class ActiveRouteStore {
  constructor(initial = {}) {
    this.snapshot = { provider: undefined, model: undefined, family: undefined, updatedAt: 0, ...initial }
    this.listeners = new Set()
    this.subscribe = listener => {
      this.listeners.add(listener)
      return () => {
        this.listeners.delete(listener)
      }
    }
    this.getSnapshot = () => this.snapshot
  }

  set(patch) {
    this.snapshot = { ...this.snapshot, ...patch }
    this.notify()
  }

  notify() {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        // A rendering subscriber must never break the route watcher.
      }
    }
  }
}

/**
 * Watches the host's persisted model preference.
 *
 * dsh-tui rewrites `~/.dsh-tui/model.json` on every `/model` switch, so
 * polling that one file is enough to notice a route change without touching
 * any host-internal service.
 */
export class ActiveRoutePoller {
  constructor(options) {
    this.store = options.store
    this.readRoute = options.readRoute ?? readActiveRoute
    this.env = options.env
    this.now = options.now ?? (() => Date.now())
    this.intervalMs = options.intervalMs ?? 5_000
    this.timer = undefined
    this.stopped = true
    this.inflight = undefined
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.timer = setInterval(() => this.tick(), this.intervalMs)
    this.timer.unref?.()
    void this.tick()
  }

  stop() {
    this.stopped = true
    if (this.timer !== undefined) {
      clearInterval(this.timer)
      this.timer = undefined
    }
  }

  async tick() {
    if (this.stopped) return
    if (this.inflight !== undefined) return
    const task = this.read().finally(() => {
      if (this.inflight === task) this.inflight = undefined
    })
    this.inflight = task
    await task
  }

  async read() {
    let route
    try {
      route = await this.readRoute(this.env)
    } catch {
      return
    }
    const current = this.store.getSnapshot()
    if (route === undefined) {
      if (current.provider !== undefined) {
        this.store.set({ provider: undefined, model: undefined, family: undefined, updatedAt: this.now() })
      }
      return
    }
    if (route.provider === current.provider && route.model === current.model) return
    this.store.set({
      provider: route.provider,
      model: route.model,
      family: route.family,
      updatedAt: this.now(),
    })
  }
}
