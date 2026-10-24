import test from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULTS } from '../lib/config.js'
import { DeepSeekStore } from '../lib/deepseek-store.js'
import { createDeepSeekStatusView } from '../lib/deepseek-view.js'

const CONFIG = {
  ...DEFAULTS,
  deepseekEnabled: true,
  deepseekShowBalance: true,
  deepseekShowToday: true,
  deepseekShowTotal: true,
  deepseekShowPeak: true,
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

function textNodes(node, out = []) {
  if (node === null || typeof node !== 'object') return out
  if (node.type === 'Text') out.push(node)
  const children = node.props?.children ?? []
  for (const child of Array.isArray(children) ? children : [children]) textNodes(child, out)
  return out
}

function readyState() {
  return {
    phase: 'ready',
    total: { cny: 77.26, currency: 'CNY' },
    today: { cny: 12.37, currency: 'CNY' },
    balance: { status: 'ok', currency: 'CNY', total: 86.5 },
    peak: { inPeak: false, label: '平价', nextLabel: '峰时', countdown: '1h29m', text: '平价 · 距峰时 1h29m' },
    notice: undefined,
    refreshing: false,
    now: Date.UTC(2026, 9, 24, 4, 31),
  }
}

test('renders a cost row and a separate peak row', () => {
  const store = new DeepSeekStore(readyState())
  const view = createDeepSeekStatusView({
    store,
    getConfig: () => CONFIG,
    onRefresh: () => {},
  })
  const tree = view({ React: fakeReact, ui: fakeUi })
  assert.equal(tree.type, 'Box')
  assert.equal(tree.props.flexDirection, 'column')
  const rows = tree.props.children
  assert.equal(rows.length, 2)
  assert.equal(rows[0].props.flexDirection, 'row')
  assert.equal(typeof rows[0].props.onClick, 'function')
  assert.equal(flatten(rows[0]), 'DeepSeek 余额 ¥86.50 · 本月 ¥77.26 · 今日 ¥12.37 ██████████')
  assert.equal(flatten(rows[1]), 'DeepSeek 平价 距峰时 1h29m')

  const nodes = textNodes(tree)
  assert.ok(nodes.some(node => node.props.children[0] === '余额 ¥86.50' && node.props.color === 'success'))
  assert.ok(nodes.some(node => node.props.children[0] === '今日 ¥12.37' && node.props.color === 'warning'))
  assert.ok(nodes.some(node => node.props.children[0] === '平价' && node.props.color === 'success'))
  assert.ok(nodes.some(node => node.props.children[0] === '█████' && node.props.color === 'success'))
  assert.ok(nodes.some(node => node.props.children[0] === '█' && node.props.color === 'warning'))
  assert.ok(nodes.some(node => node.props.children[0] === '████' && node.props.dimColor === true))
})

test('renders the refresh marker and placeholder states', () => {
  const store = new DeepSeekStore({ ...readyState(), refreshing: true })
  const view = createDeepSeekStatusView({
    store,
    getConfig: () => CONFIG,
    onRefresh: () => {},
  })
  assert.match(flatten(view({ React: fakeReact, ui: fakeUi })), /⟳/u)

  const empty = new DeepSeekStore({ phase: 'idle' })
  assert.equal(
    flatten(createDeepSeekStatusView({ store: empty, getConfig: () => CONFIG, onRefresh: () => {} })({ React: fakeReact, ui: fakeUi })),
    'DeepSeek 读取中…',
  )

  const error = new DeepSeekStore({ phase: 'error' })
  assert.equal(
    flatten(createDeepSeekStatusView({ store: error, getConfig: () => CONFIG, onRefresh: () => {} })({ React: fakeReact, ui: fakeUi })),
    'DeepSeek 费用不可用',
  )
})

test('renders nothing when the DeepSeek line is disabled', () => {
  const store = new DeepSeekStore(readyState())
  const view = createDeepSeekStatusView({
    store,
    getConfig: () => ({ ...CONFIG, deepseekEnabled: false }),
    onRefresh: () => {},
  })
  assert.equal(view({ React: fakeReact, ui: fakeUi }), null)
})
