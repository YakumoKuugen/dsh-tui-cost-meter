import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { SessionRouteTracker, pickActiveSession, resolveSessionRoute } from '../lib/session-route.js'

function session(id, route, header = {}) {
  return {
    id,
    header: { id, delegationDepth: 0, ...header },
    requestContext: () => route,
  }
}

test('follows request/context events of the prompted session', () => {
  const tracker = new SessionRouteTracker()
  const codex = session('s-codex')
  const minimax = session('s-minimax')

  tracker.observe(codex, { type: 'request/context', time: 10, data: { provider: 'openai-codex', model: 'gpt-6-astra' } })
  tracker.observe(codex, { type: 'user/message', time: 11 })
  assert.deepEqual(tracker.activeRoute(), { provider: 'openai-codex', model: 'gpt-6-astra' })

  // A second session on another model takes over once the user prompts it.
  tracker.observe(minimax, { type: 'user/message', time: 20 })
  tracker.observe(minimax, { type: 'request/context', time: 21, data: { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' } })
  assert.deepEqual(tracker.activeRoute(), { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' })
  assert.equal(tracker.activeSessionId(), 's-minimax')
})

test('seeds the route from a live session that ran before the plugin loaded', () => {
  const tracker = new SessionRouteTracker()
  const live = session('s-live', { provider: 'command', model: 'deepseek/deepseek-v4-flash' })
  tracker.observe(live, { type: 'step/start', time: 5 })
  assert.deepEqual(tracker.activeRoute(), { provider: 'command', model: 'deepseek/deepseek-v4-flash' })
})

test('ignores subagent sessions so their model cannot steal the row', () => {
  const tracker = new SessionRouteTracker()
  const root = session('s-root')
  tracker.observe(root, { type: 'user/message', time: 5 })
  tracker.observe(root, { type: 'request/context', time: 6, data: { provider: 'command', model: 'm' } })

  const child = session('s-child', { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' }, { delegationDepth: 1 })
  tracker.observe(child, { type: 'user/message', time: 9 })
  assert.equal(tracker.activeSessionId(), 's-root')
  assert.deepEqual(tracker.activeRoute(), { provider: 'command', model: 'm' })

  const explicit = session('s-child2', { provider: 'minimax-cn', model: 'x' }, { origin: 'subagent' })
  tracker.observe(explicit, { type: 'user/message', time: 10 })
  assert.equal(tracker.activeSessionId(), 's-root')
})

test('elects the resumed session among several live ones', async () => {
  const home = await mkdtemp(join(tmpdir(), 'cost-meter-route-'))
  try {
    const dir = join(home, '.dsh-tui')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'resume.txt'), 's-b')
    await writeFile(join(dir, 'last-used.json'), JSON.stringify({ 's-a': 100, 's-b': 50 }))
    await writeFile(join(dir, 'session-mounts.json'), JSON.stringify({
      version: 1,
      owners: [{ pid: process.pid, sessionIds: ['s-a', 's-b', 's-other'] }],
    }))

    const a = session('s-a')
    const b = session('s-b')
    const chosen = await pickActiveSession([a, b], { home })
    assert.equal(chosen.id, 's-b')

    await writeFile(join(dir, 'resume.txt'), 's-missing')
    const byRecency = await pickActiveSession([a, b], { home })
    assert.equal(byRecency.id, 's-a')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('resolves the live session route before falling back', async () => {
  const tracker = new SessionRouteTracker()
  const live = session('s-1', { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' })
  const resolved = await resolveSessionRoute({ tracker, sessions: [live] })
  assert.equal(resolved.provider, 'minimax-cn')
  assert.equal(resolved.family, 'minimax')
  assert.equal(resolved.sessionId, 's-1')

  assert.equal(await resolveSessionRoute({ tracker: new SessionRouteTracker(), sessions: [] }), undefined)
})
