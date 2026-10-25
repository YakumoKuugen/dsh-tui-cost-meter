import test from 'node:test'
import assert from 'node:assert/strict'
import z from '@deepseek-ai/schemastery'

import { Config, DEFAULTS, clampInt, liveValue, readConfig } from '../lib/config.js'
import { buildSettingsSection } from '../lib/settings.js'

test('schema defaults match DEFAULTS', () => {
  const resolved = readConfig(Config({}))
  assert.deepEqual(resolved, { ...DEFAULTS })
})

test('readConfig unwraps volatile handles and clamps out-of-range values', () => {
  const config = {
    enabled: { get: () => true },
    window: { get: () => 'weekly' },
    barWidth: { get: () => 999 },
    showLabel: { get: () => false },
    showReset: { get: () => true },
    showUnavailable: { get: () => false },
    warnAt: { get: () => -5 },
    dangerAt: { get: () => 200 },
    refreshSeconds: { get: () => 2 },
    deepseekEnabled: { get: () => false },
    deepseekShowBalance: { get: () => false },
    deepseekShowToday: { get: () => false },
    deepseekShowTotal: { get: () => false },
    deepseekShowPeak: { get: () => false },
    deepseekShowBar: { get: () => false },
    deepseekBarWidth: { get: () => 2 },
    deepseekPeakNotify: { get: () => false },
    deepseekRefreshSeconds: { get: () => 1 },
    minimaxEnabled: { get: () => false },
    minimaxWindow: { get: () => 'weekly' },
    minimaxBarWidth: { get: () => 2 },
    minimaxWarnAt: { get: () => 200 },
    minimaxDangerAt: { get: () => -5 },
    minimaxRefreshSeconds: { get: () => 5 },
  }
  assert.deepEqual(readConfig(config), {
    enabled: true,
    window: 'weekly',
    barWidth: 40,
    showLabel: false,
    showReset: true,
    showUnavailable: false,
    warnAt: 0,
    dangerAt: 100,
    refreshSeconds: 15,
    deepseekEnabled: false,
    deepseekShowBalance: false,
    deepseekShowToday: false,
    deepseekShowTotal: false,
    deepseekShowPeak: false,
    deepseekShowBar: false,
    deepseekBarWidth: 4,
    deepseekPeakNotify: false,
    deepseekRefreshSeconds: 30,
    minimaxEnabled: false,
    minimaxWindow: 'weekly',
    minimaxBarWidth: 4,
    minimaxWarnAt: 100,
    minimaxDangerAt: 0,
    minimaxRefreshSeconds: 30,
  })
})

test('readConfig tolerates a missing or throwing volatile handle', () => {
  assert.equal(liveValue(undefined, 'fallback'), 'fallback')
  assert.equal(liveValue({ get: () => undefined }, 'fallback'), 'fallback')
  assert.equal(liveValue({ get: () => { throw new Error('gone') } }, 'fallback'), 'fallback')
  assert.equal(liveValue('plain', 'fallback'), 'plain')
  assert.equal(clampInt(Number.NaN, 1, 5, 3), 3)
  assert.equal(clampInt('7', 1, 5, 3), 5)
  assert.equal(clampInt(2.9, 1, 5, 3), 2)
  assert.deepEqual(readConfig({}), { ...DEFAULTS })
  assert.equal(readConfig({ window: 'bogus' }).window, DEFAULTS.window)
})

test('every settings field addresses a volatile Config path', () => {
  const rebuilt = new z(Config.toJSON())
  const section = buildSettingsSection('dsh-tui-cost-meter')
  assert.equal(section.ns, 'dsh-tui-cost-meter')
  assert.ok(section.fields.length >= 8)
  for (const field of section.fields) {
    assert.equal(field.path.length, 1)
    const key = field.path[0]
    const child = rebuilt.dict?.[key]
    assert.ok(child, `missing schema field ${key}`)
    assert.equal(child.meta?.volatile, true, `${key} must be volatile so /settings can edit it`)
  }
  assert.equal(new Set(section.fields.map(field => field.path[0])).size, section.fields.length)
})

test('number fields validate drafts and clear on empty input', () => {
  const section = buildSettingsSection('dsh-tui-cost-meter')
  const width = section.fields.find(field => field.path[0] === 'barWidth')
  assert.equal(width?.kind, 'number')
  assert.equal(width?.format(12), '12')
  assert.deepEqual(width?.parse('16'), { kind: 'set', value: 16 })
  assert.deepEqual(width?.parse(''), { kind: 'clear' })
  assert.equal(width?.parse('3'), undefined)
  assert.equal(width?.parse('41'), undefined)
  assert.equal(width?.parse('12.5'), undefined)
  assert.equal(width?.parse('nope'), undefined)
})

test('window select exposes every supported mode', () => {
  const section = buildSettingsSection('dsh-tui-cost-meter')
  const window = section.fields.find(field => field.path[0] === 'window')
  assert.equal(window?.kind, 'select')
  assert.deepEqual(window?.options?.map(option => option.value), ['auto', 'fiveHour', 'weekly', 'shortest', 'longest'])
})
