import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
  assert.equal(familyOfProvider('llm-deepseek'), 'deepseek')
  assert.equal(familyOfProvider('llm-deepseek-account'), 'deepseek')
  assert.equal(familyOfProvider('llm-minimax-cn'), 'minimax')
  assert.equal(familyOfProvider('llm-openai-codex'), 'codex')
  assert.equal(familyOfProvider('command'), 'commandcode')
  assert.equal(familyOfProvider('commandcode'), 'commandcode')
  assert.equal(familyOfProvider('llm-command'), 'commandcode')
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
    await mkdir(join(dir, '.dsh-tui'), { recursive: true })
    await writeFile(
      join(dir, '.dsh-tui', 'model.json'),
      JSON.stringify({ provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash' }),
    )
    const route = await readActiveRoute(dir)
    assert.equal(route?.provider, 'minimax-cn')
    assert.equal(route?.model, 'MiniMax-M3.1-Flash')
    assert.equal(route?.family, 'minimax')

    assert.equal(await readModelPref(join(dir, 'absent')), undefined)
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
  assert.equal(modelPrefPath('/tmp/x'), join('/tmp/x', '.dsh-tui', 'model.json'))
  assert.ok(modelPrefPath('/tmp/x').endsWith('.dsh-tui/model.json'))
})
