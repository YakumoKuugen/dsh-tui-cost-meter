import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS } from '../lib/config.js'
import { ActiveRouteStore } from '../lib/active-model.js'
import { MiniMaxStore } from '../lib/minimax-store.js'
import { createMiniMaxStatusView } from '../lib/minimax-view.js'

const CONFIG = {
  ...DEFAULTS,
  minimaxEnabled: true,
  minimaxWindow: 'auto',
  minimaxBarWidth: 10,
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
    quota: { intervalPercent: 68, weeklyPercent: 76, intervalUnlimited: false, weeklyUnlimited: false },
    refreshing: false,
  }
}

test('renders the MiniMax quota row', () => {
  const store = new MiniMaxStore(readyState())
  const view = createMiniMaxStatusView({ store, getConfig: () => CONFIG, onRefresh: () => {} })
  const tree = view({ React: fakeReact, ui: fakeUi })
  assert.equal(tree.type, 'Box')
  assert.equal(flatten(tree), 'MiniMax 5h ███████░░░ 68%')
})

test('hides the row while another provider is in use', () => {
  const store = new MiniMaxStore(readyState())
  const activeStore = new ActiveRouteStore({ provider: 'deepseek', model: 'deepseek-flash', family: 'deepseek' })
  const view = createMiniMaxStatusView({
    store,
    getConfig: () => CONFIG,
    activeStore,
    onRefresh: () => {},
  })
  assert.equal(view({ React: fakeReact, ui: fakeUi }), null)
})

test('shows the row while MiniMax is the active provider', () => {
  const store = new MiniMaxStore(readyState())
  const activeStore = new ActiveRouteStore({ provider: 'minimax-cn', model: 'MiniMax-M3.1-Flash', family: 'minimax' })
  const view = createMiniMaxStatusView({
    store,
    getConfig: () => CONFIG,
    activeStore,
    onRefresh: () => {},
  })
  assert.notEqual(view({ React: fakeReact, ui: fakeUi }), null)
})
