import test from 'node:test'
import assert from 'node:assert/strict'

import { QuotaStore } from '../lib/store.js'
import { createQuotaStatusView } from '../lib/view.js'

const USAGE = {
  rateLimits: [{
    id: 'codex',
    name: 'Codex',
    windows: [
      { remainingPercent: 63, windowSeconds: 18_000 },
      { remainingPercent: 42, windowSeconds: 604_800 },
    ],
  }],
}

const CONFIG = {
  enabled: true,
  window: 'auto',
  barWidth: 10,
  showLabel: true,
  showReset: false,
  showUnavailable: true,
  warnAt: 30,
  dangerAt: 10,
  refreshSeconds: 60,
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

test('renders one row with label, bar, percentage and a click target', () => {
  const store = new QuotaStore({ phase: 'ready', usage: USAGE })
  const view = createQuotaStatusView({
    store,
    getConfig: () => CONFIG,
    onRefresh: () => {},
  })
  const tree = view({ React: fakeReact, ui: fakeUi })

  assert.equal(tree.type, 'Box')
  assert.equal(tree.props.flexDirection, 'row')
  assert.equal(tree.props.height, 1)
  assert.equal(typeof tree.props.onClick, 'function')
  assert.equal(flatten(tree), 'Codex 5h ██████░░░░ 63%')

  const nodes = textNodes(tree)
  assert.ok(nodes.some(node => node.props.children[0] === 'Codex 5h '))
  assert.ok(nodes.some(node => node.props.children[0] === ' 63%' && node.props.color === 'success'))
})

test('renders nothing when the feature is disabled', () => {
  const store = new QuotaStore({ phase: 'ready', usage: USAGE })
  const view = createQuotaStatusView({
    store,
    getConfig: () => ({ ...CONFIG, enabled: false }),
    onRefresh: () => {},
  })
  assert.equal(view({ React: fakeReact, ui: fakeUi }), null)
})

test('renders the signed-out placeholder', () => {
  const store = new QuotaStore({ phase: 'signed-out' })
  const view = createQuotaStatusView({
    store,
    getConfig: () => CONFIG,
    onRefresh: () => {},
  })
  const tree = view({ React: fakeReact, ui: fakeUi })
  assert.equal(flatten(tree), 'Codex 未登录 · /login')
})

test('renders a red low-quota bar', () => {
  const low = {
    rateLimits: [{
      id: 'codex',
      windows: [{ remainingPercent: 5, windowSeconds: 18_000 }],
    }],
  }
  const store = new QuotaStore({ phase: 'ready', usage: low })
  const view = createQuotaStatusView({
    store,
    getConfig: () => ({ ...CONFIG, barWidth: 10 }),
    onRefresh: () => {},
  })
  const tree = view({ React: fakeReact, ui: fakeUi })
  const nodes = textNodes(tree)
  assert.ok(nodes.some(node => node.props.children[0] === '█' && node.props.color === 'error'))
  assert.ok(nodes.some(node => node.props.children[0] === '░'.repeat(9) && node.props.dimColor === true))
  assert.equal(flatten(tree), 'Codex 5h █░░░░░░░░░ 5%')
})
