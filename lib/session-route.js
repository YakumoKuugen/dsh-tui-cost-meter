/**
 * Which model THIS window is using.
 *
 * `~/.dsh-tui/model.json` is a single global preference: it records the last
 * `/model` pick of the last window that picked one. Two dsh-tui windows — or
 * two sessions in one window — can run different models, so that file is only
 * a fallback here.
 *
 * The authoritative per-window source is the host's own event stream: every
 * session in this process publishes `session/event`, and `request/context`
 * carries the resolved `{ provider, model }` of the request that just ran.
 * The tracker keeps the latest route per session and elects the session the
 * user is looking at (the one that received the most recent prompt). Because
 * each dsh-tui process mounts only its own sessions, the answer is naturally
 * per-instance — no shared state between windows.
 *
 * When no event has arrived yet (plugin loaded mid-session, or the window has
 * not run a request since start), the live sessions of this process are read
 * once and the most recently used one wins.
 */

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { familyOfProvider } from './active-model.js'

/** dsh-tui's data directory. The host hard-codes it; no env override exists. */
export function tuiDataDir(home = homedir()) {
  return join(home, '.dsh-tui')
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isRoute(value) {
  return isRecord(value)
    && typeof value.provider === 'string'
    && value.provider.length > 0
    && typeof value.model === 'string'
    && value.model.length > 0
}

/** Whether a live session is a top-level conversation (not a subagent). */
export function isRootSession(session) {
  const header = session?.header
  if (header === undefined || header === null) return false
  if (header.origin === 'subagent') return false
  const depth = header.delegationDepth
  return depth === undefined || depth === null || depth === 0
}

/**
 * Track the latest route per session and the session the user last prompted.
 */
export class SessionRouteTracker {
  constructor() {
    this.sessions = new Map()
    this.activeId = undefined
  }

  /**
   * Fold one `session/event` into the table.
   *
   * @param {object} session - live Session instance from the host
   * @param {{type?: string, time?: number, data?: unknown}} event
   * @returns {{provider: string, model: string}|undefined} the active route
   */
  observe(session, event) {
    if (!isRootSession(session)) return this.activeRoute()
    const id = typeof session?.id === 'string' ? session.id : session?.header?.id
    if (typeof id !== 'string' || id.length === 0) return this.activeRoute()
    const entry = this.sessions.get(id) ?? { route: undefined, lastUserAt: 0, lastEventAt: 0 }

    // The live session can answer for requests that ran before this plugin
    // row was composed, so a window that installs mid-session still starts
    // from the right route.
    if (entry.route === undefined) {
      try {
        const context = session?.requestContext?.()
        if (isRoute(context)) entry.route = { provider: context.provider, model: context.model }
      } catch {
        // A host without the accessor keeps the event-only path.
      }
    }

    if (event?.type === 'request/context' && isRoute(event.data)) {
      entry.route = { provider: event.data.provider, model: event.data.model }
    }
    if (event?.type === 'user/message' && Number.isFinite(Number(event.time))) {
      entry.lastUserAt = Number(event.time)
      this.activeId = id
    }
    if (Number.isFinite(Number(event?.time))) {
      entry.lastEventAt = Number(event.time)
    }
    this.sessions.set(id, entry)
    if (this.activeId === undefined) this.activeId = id
    return this.activeRoute()
  }

  /** Remember a route discovered outside the event stream (startup seeding). */
  remember(id, route, lastUserAt = 0) {
    if (typeof id !== 'string' || id.length === 0 || !isRoute(route)) return
    const entry = this.sessions.get(id) ?? { route: undefined, lastUserAt: 0, lastEventAt: 0 }
    entry.route = { provider: route.provider, model: route.model }
    if (lastUserAt > entry.lastUserAt) {
      entry.lastUserAt = lastUserAt
      this.activeId = id
    } else if (this.activeId === undefined) {
      this.activeId = id
    }
    this.sessions.set(id, entry)
  }

  /** The route of the session the user last prompted, when known. */
  activeRoute() {
    if (this.activeId === undefined) return undefined
    return this.sessions.get(this.activeId)?.route
  }

  /** The session id behind {@link activeRoute}. */
  activeSessionId() {
    return this.activeId
  }

  reset() {
    this.sessions.clear()
    this.activeId = undefined
  }
}

/** Read `~/.dsh-tui/last-used.json` (session id → epoch ms), tolerating damage. */
export async function readLastUsed(home = homedir()) {
  try {
    const parsed = JSON.parse(await readFile(join(tuiDataDir(home), 'last-used.json'), 'utf8'))
    return isRecord(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/** Read `~/.dsh-tui/resume.txt` (the session a relaunch would resume). */
export async function readResumeId(home = homedir()) {
  try {
    const text = await readFile(join(tuiDataDir(home), 'resume.txt'), 'utf8')
    const id = text.trim()
    return id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

/** Read the session ids this process has mounted, per `session-mounts.json`. */
export async function readMountedSessionIds(pid, home = homedir()) {
  try {
    const parsed = JSON.parse(await readFile(join(tuiDataDir(home), 'session-mounts.json'), 'utf8'))
    const owners = Array.isArray(parsed?.owners) ? parsed.owners : []
    const owner = owners.find(entry => isRecord(entry) && entry.pid === pid)
    return Array.isArray(owner?.sessionIds) ? owner.sessionIds.filter(id => typeof id === 'string') : []
  } catch {
    return []
  }
}

/**
 * Elect the session this window is showing among the live root sessions.
 *
 * `resume.txt` wins when it names one of them, because that is the session the
 * window would restore; otherwise the most recently used id from
 * `last-used.json` wins. A single live session needs no tie-break.
 *
 * @param {object[]} sessions - live root sessions of this process
 * @param {{home?: string, mountedIds?: string[]}} [options]
 */
export async function pickActiveSession(sessions, options = {}) {
  const candidates = (Array.isArray(sessions) ? sessions : []).filter(isRootSession)
  if (candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]

  const home = options.home ?? homedir()
  const mountedIds = new Set(options.mountedIds ?? [])
  const scoped = mountedIds.size === 0
    ? candidates
    : candidates.filter(session => mountedIds.has(session.id))
  const pool = scoped.length > 0 ? scoped : candidates
  const byId = new Map(pool.map(session => [session.id, session]))

  const resumeId = await readResumeId(home)
  if (resumeId !== undefined && byId.has(resumeId)) return byId.get(resumeId)

  const lastUsed = await readLastUsed(home)
  let best
  let bestAt = -1
  for (const session of pool) {
    const at = Number(lastUsed[session.id] ?? 0)
    if (Number.isFinite(at) && at > bestAt) {
      best = session
      bestAt = at
    }
  }
  return bestAt > 0 ? best : undefined
}

/**
 * Resolve the route of this window.
 *
 * Order: the live event tracker, then the live sessions of this process, then
 * the global `model.json` fallback (which the caller passes in).
 *
 * @param {{tracker?: SessionRouteTracker, sessions?: object[], home?: string, mountedIds?: string[]}} options
 * @returns {Promise<{provider: string, model: string, family: string|undefined, sessionId?: string}|undefined>}
 */
export async function resolveSessionRoute(options = {}) {
  const tracker = options.tracker
  const live = tracker?.activeRoute()
  if (isRoute(live)) {
    return {
      provider: live.provider,
      model: live.model,
      family: familyOfProvider(live.provider),
      sessionId: tracker.activeSessionId(),
    }
  }

  const sessions = Array.isArray(options.sessions) ? options.sessions : []
  if (sessions.length > 0) {
    const active = await pickActiveSession(sessions, {
      home: options.home,
      mountedIds: options.mountedIds,
    })
    if (active !== undefined) {
      try {
        const context = active.requestContext?.()
        if (isRoute(context)) {
          return {
            provider: context.provider,
            model: context.model,
            family: familyOfProvider(context.provider),
            sessionId: active.id,
          }
        }
      } catch {
        // Fall through to the global preference.
      }
    }
  }
  return undefined
}
