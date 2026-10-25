import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ActiveRoutePoller,
  ActiveRouteStore,
  familyOfProvider,
  isFamilyActive,
  modelPrefPath,
  parseModelPref,
  readActiveRoute,
  readModelPref,
} from '../lib/active-model.js'

test('parses the persisted model preference', () => {
  assert.deepEqual(parseModelPref('{"provider":"minimax-cn","model":"MiniMax-M3.1-Flash"}'), {
    provider: 'minimax-cn',
    model: 'MiniMax-M3.1-Flash',
  })
  assert.equal(parseModelPref('not json'), undefined)
  assert.equal(parseModelPref('{"provider":"minimax-cn"}'), undefined)
  assert.equal(parseModelPref('[]'), undefined)
})

test('classifies the provider families', () => {
  assert.equal(familyOfProvider('openai-codex'), 'codex')
  assert.equal(familyOfProvider('minimax'), 'minimax')
  assert.equal(familyOfProvider('minimax-cn'), 'minimax')
  assert.equal(familyOfProvider('deepseek'), 'deepseek')
  assert.equal(familyOfProvider('deepseek-account'), 'deepseek')
  assert.equal(familyOfProvider('anthropic'), undefined)
  assert.equal(familyOfProvider(undefined), undefined)
})

test('shows a module only while its family is the active one', () => {
  assert.equal(isFamilyActive({ family: 'minimax' }, 'minimax'), true)
  assert.equal(isFamilyActive({ family: 'minimax' }, 'codex'), false)
  assert.equal(isFamilyActive({ family: 'deepseek' }, 'deepseek'), true)
  // An unknown route keeps every module visible.
  assert.equal(isFamilyActive(undefined, 'codex'), true)
  assert.equal(isFamilyActive({ family: undefined }, 'codex'), true)
})

test('reads the route from the host preference file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cost-meter-route-'))
  try {
    await writeFile(join(dir, 'model.json'), JSON.stringify({ provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' }))
    const route = await readActiveRoute({ DSH_TUI_HOME: dir })
    assert.equal(route?.provider, 'minimax-cn')
    assert.equal(route?.model, 'MiniMax-M3.1-Flash')
    assert.equal(route?.family, 'minimax')

    assert.equal(await readModelPref({ DSH_TUI_HOME: join(dir, 'absent') }), undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('the route watcher publishes a changed provider', async () => {
  const store = new ActiveRouteStore()
  let route = { provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash', family: 'minimax' }
  const poller = new ActiveRoutePoller({ store, readRoute: async () => route })
  await poller.read()
  assert.equal(store.getSnapshot().family, 'minimax')

  route = { provider: 'deepseek', model: 'deepseek-flash', family: 'deepseek' }
  await poller.read()
  assert.equal(store.getSnapshot().family, 'deepseek')
  assert.equal(store.getSnapshot().model, 'deepseek-flash')
})

test('the route path follows the host data directory', () => {
  assert.ok(modelPrefPath({ DSH_TUI_HOME: '/tmp/x' }).endsWith('/tmp/x/model.json'))
  assert.ok(modelPrefPath({}).endsWith('.dsh-tui/model.json'))
})
