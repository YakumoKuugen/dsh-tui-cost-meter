import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS } from '../lib/config.js'
import { ActiveRouteStore } from '../lib/active-model.js'
import { CommandCodeStore } from '../lib/commandcode-store.js'
import { createCommandCodeStatusView } from '../lib/commandcode-view.js'

const CONFIG = {
  ...DEFAULTS,
  commandcodeEnabled: true,
  commandcodeWindow: 'auto',
  commandcodeBarWidth: 10,
}

const fakeReact = {
  createElement(type, props, ...children) {
    return { type, props: { ...props, children } }
  },
  useSyncExternalStore(_subscribe, getSnapshot) {
    return getSnapshot()
  },
}

const fakeUi = {
  Box: 'Box',
  Text: 'Text',
  useTerminalSize: () => ({ columns: 80, rows: 24 }),
}

function flatten(node) {
  if (typeof node === 'string') return node
  if (node === null || node === undefined) return ''
  if (typeof node !== 'object') return String(node)
  const children = node.props?.children ?? []
  return (Array.isArray(children) ? children : [children]).map(flatten).join('')
}

function readyState() {
  return {
    phase: 'ready',
    quota: { fiveHourPercent: 100, weeklyPercent: 50, monthlyCredits: 10 },
    refreshing: false,
  }
}

test('renders the CommandCode quota row', () => {
  const store = new CommandCodeStore(readyState())
  const view = createCommandCodeStatusView({ store, getConfig: () => CONFIG, onRefresh: () => {} })
  const tree = view({ React: fakeReact, ui: fakeUi })
  assert.equal(tree.type, 'Box')
  assert.equal(flatten(tree), 'CommandCode 5h ██████████ 100% · 7d 50% · $10')
})

test('hides the row while another provider is in use', () => {
  const store = new CommandCodeStore(readyState())
  const activeStore = new ActiveRouteStore({ provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash', family: 'minimax' })
  const view = createCommandCodeStatusView({
    store,
    getConfig: () => CONFIG,
    activeStore,
    onRefresh: () => {},
  })
  assert.equal(view({ React: fakeReact, ui: fakeUi }), null)
})

test('shows the row while CommandCode is the active provider', () => {
  const store = new CommandCodeStore(readyState())
  const activeStore = new ActiveRouteStore({ provider: 'command', model: 'deepseek/deepseek-v4-flash', family: 'commandcode' })
  const view = createCommandCodeStatusView({
    store,
    getConfig: () => CONFIG,
    activeStore,
    onRefresh: () => {},
  })
  assert.notEqual(view({ React: fakeReact, ui: fakeUi }), null)
})
