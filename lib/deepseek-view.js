/**
 * Host-React view for the DeepSeek balance/cost/peak row.
 *
 * Same one-row contract as the Codex view: no React import, only the host's
 * `React` and pointer-only `ui` kit.
 */

import { buildDeepSeekViewModel } from './deepseek.js'
import { PROVIDER_FAMILIES, isFamilyActive } from './active-model.js'

/** Build the inline Text children for one DeepSeek model. */
export function buildDeepSeekChildren(React, ui, model) {
  if (model === undefined) return []
  const children = []
  if (model.label !== undefined) {
    children.push(React.createElement(ui.Text, { key: 'label', dimColor: true, wrap: 'truncate' }, `${model.label} `))
  }
  for (const [index, segment] of (model.segments ?? []).entries()) {
    if (index > 0) {
      children.push(React.createElement(ui.Text, { key: `sep-${index}`, dimColor: true, wrap: 'truncate' }, ' · '))
    }
    children.push(React.createElement(
      ui.Text,
      {
        key: `segment-${index}`,
        ...(segment.dim === true ? { dimColor: true } : {}),
        ...(segment.color === undefined ? {} : { color: segment.color }),
        wrap: 'truncate',
      },
      segment.text,
    ))
  }
  if (model.bar !== undefined) {
    children.push(React.createElement(ui.Text, { key: 'bar-space', dimColor: true, wrap: 'truncate' }, ' '))
    if (model.bar.remaining > 0) {
      children.push(React.createElement(ui.Text, { key: 'bar-remaining', color: 'success', wrap: 'truncate' }, '█'.repeat(model.bar.remaining)))
    }
    if (model.bar.today > 0) {
      children.push(React.createElement(ui.Text, { key: 'bar-today', color: 'warning', wrap: 'truncate' }, '█'.repeat(model.bar.today)))
    }
    if (model.bar.used > 0) {
      children.push(React.createElement(ui.Text, { key: 'bar-used', dimColor: true, wrap: 'truncate' }, '█'.repeat(model.bar.used)))
    }
  }
  if (model.refreshing === true) {
    children.push(React.createElement(ui.Text, { key: 'refresh', dimColor: true, wrap: 'truncate' }, ' ⟳'))
  }
  return children
}

/** Build the second row: phase label + peak bar + countdown. */
export function buildDeepSeekPeakChildren(React, ui, model) {
  if (model?.peakRow === undefined) return []
  const peak = model.peakRow
  const children = [
    React.createElement(ui.Text, { key: 'peak-label', dimColor: true, wrap: 'truncate' }, `${model.label} `),
    React.createElement(ui.Text, { key: 'peak-phase', color: peak.color, wrap: 'truncate' }, peak.label),
  ]
  if (peak.barText !== undefined) {
    children.push(React.createElement(ui.Text, { key: 'peak-space', dimColor: true, wrap: 'truncate' }, ' '))
    children.push(React.createElement(ui.Text, { key: 'peak-bar', color: peak.color, wrap: 'truncate' }, peak.barText))
  }
  if (peak.countdown !== undefined) {
    children.push(React.createElement(ui.Text, { key: 'peak-countdown', dimColor: true, wrap: 'truncate' }, ` ${peak.countdown}`))
  }
  return children
}

/** Create the component handed to `ctx.tuiStatus.registerView`. */
export function createDeepSeekStatusView(options) {
  const { store, getConfig, onRefresh, activeStore } = options
  return function DeepSeekCostStatusView({ React, ui }) {
    const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const active = activeStore === undefined
      ? undefined
      : React.useSyncExternalStore(activeStore.subscribe, activeStore.getSnapshot, activeStore.getSnapshot)
    const terminal = ui.useTerminalSize()
    const model = buildDeepSeekViewModel(state, getConfig(), {
      columns: terminal?.columns,
      now: state?.now,
    })
    if (model === undefined) return null
    if (!isFamilyActive(active, PROVIDER_FAMILIES.DEEPSEEK)) return null
    const rows = [
      React.createElement(
        ui.Box,
        {
          key: 'cost',
          flexDirection: 'row',
          width: '100%',
          height: 1,
          flexShrink: 0,
          paddingX: 1,
          overflow: 'hidden',
          onClick: onRefresh,
        },
        ...buildDeepSeekChildren(React, ui, model),
      ),
    ]
    if (model.peakRow !== undefined) {
      rows.push(React.createElement(
        ui.Box,
        {
          key: 'peak',
          flexDirection: 'row',
          width: '100%',
          height: 1,
          flexShrink: 0,
          paddingX: 1,
          overflow: 'hidden',
          onClick: onRefresh,
        },
        ...buildDeepSeekPeakChildren(React, ui, model),
      ))
    }
    return React.createElement(
      ui.Box,
      { flexDirection: 'column', width: '100%', flexShrink: 0 },
      ...rows,
    )
  }
}
