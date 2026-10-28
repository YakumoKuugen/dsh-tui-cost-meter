/**
 * Host-React view for the CommandCode quota row.
 *
 * Same one-row contract as the Codex view: the host's React instance plus a
 * pointer-only UI kit, never Ink or a React import.
 */

import { buildCommandCodeViewModel } from './commandcode.js'
import { PROVIDER_FAMILIES, isFamilyActive } from './active-model.js'

/** Build the inline Text children for one CommandCode plan. */
export function buildCommandCodeChildren(React, ui, model) {
  if (model === undefined) return []
  const children = []
  if (model.label !== undefined) {
    children.push(React.createElement(ui.Text, { key: 'label', dimColor: true, wrap: 'truncate' }, `${model.label} `))
  }
  if (model.kind === 'placeholder') {
    children.push(React.createElement(ui.Text, { key: 'placeholder', dimColor: true, wrap: 'truncate' }, model.placeholder))
    if (model.refreshing === true) {
      children.push(React.createElement(ui.Text, { key: 'refresh', dimColor: true, wrap: 'truncate' }, ' ⟳'))
    }
    return children
  }

  children.push(React.createElement(ui.Text, { key: 'window', dimColor: true, wrap: 'truncate' }, `${model.windowLabel} `))
  if (model.filledText !== '') {
    children.push(React.createElement(ui.Text, { key: 'filled', color: model.color, wrap: 'truncate' }, model.filledText))
  }
  if (model.emptyText !== '') {
    children.push(React.createElement(ui.Text, { key: 'empty', dimColor: true, wrap: 'truncate' }, model.emptyText))
  }
  children.push(React.createElement(ui.Text, { key: 'percent', color: model.color, wrap: 'truncate' }, ` ${model.percentText}`))
  if (model.otherPercentText !== undefined) {
    children.push(React.createElement(
      ui.Text,
      { key: 'other-window', dimColor: true, wrap: 'truncate' },
      ` · ${model.otherLabel} ${model.otherPercentText}`,
    ))
  }
  if (model.creditsText !== undefined) {
    children.push(React.createElement(ui.Text, { key: 'credits', dimColor: true, wrap: 'truncate' }, ` · ${model.creditsText}`))
  }
  if (model.refreshing === true) {
    children.push(React.createElement(ui.Text, { key: 'refresh', dimColor: true, wrap: 'truncate' }, ' ⟳'))
  }
  return children
}

/** Create the component handed to `ctx.tuiStatus.registerView`. */
export function createCommandCodeStatusView(options) {
  const { store, getConfig, onRefresh, activeStore } = options
  return function CommandCodeQuotaStatusView({ React, ui }) {
    const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const active = activeStore === undefined
      ? undefined
      : React.useSyncExternalStore(activeStore.subscribe, activeStore.getSnapshot, activeStore.getSnapshot)
    const terminal = ui.useTerminalSize()
    const model = buildCommandCodeViewModel(state, getConfig(), { columns: terminal?.columns })
    if (model === undefined) return null
    if (!isFamilyActive(active, PROVIDER_FAMILIES.COMMANDCODE)) return null
    return React.createElement(
      ui.Box,
      {
        flexDirection: 'row',
        width: '100%',
        height: 1,
        flexShrink: 0,
        paddingX: 1,
        overflow: 'hidden',
        onClick: onRefresh,
      },
      ...buildCommandCodeChildren(React, ui, model),
    )
  }
}
