/**
 * Host-React view for the Codex quota status line.
 *
 * dsh-tui passes its own React instance plus a pointer-only UI kit, so this
 * module never imports React or Ink. Layout is one row: optional label, the
 * progress bar split into filled/empty cells, then the percentage and an
 * optional reset countdown.
 */

import { buildStatusViewModel } from './quota.js'
import { PROVIDER_FAMILIES, isFamilyActive } from './active-model.js'

/**
 * Build the text children for one model snapshot.
 *
 * @param {object} React - host React instance
 * @param {{Text: any}} ui - host UI kit
 * @param {object|undefined} model - projected view model
 * @returns {Array<object>}
 */
export function buildQuotaChildren(React, ui, model) {
  if (model === undefined) return []
  const children = []
  if (model.label !== undefined) {
    children.push(React.createElement(ui.Text, { key: 'label', dimColor: true }, `${model.label} `))
  }

  if (model.kind === 'placeholder') {
    children.push(React.createElement(ui.Text, { key: 'placeholder', dimColor: true }, model.placeholder))
    if (model.refreshing === true) {
      children.push(React.createElement(ui.Text, { key: 'refresh', dimColor: true }, ' ⟳'))
    }
    return children
  }

  if (model.filledText !== '') {
    children.push(React.createElement(ui.Text, { key: 'filled', color: model.color }, model.filledText))
  }
  if (model.emptyText !== '') {
    children.push(React.createElement(ui.Text, { key: 'empty', dimColor: true }, model.emptyText))
  }
  children.push(React.createElement(ui.Text, { key: 'percent', color: model.color }, ` ${model.percentText}`))
  if (model.resetText !== undefined) {
    children.push(React.createElement(ui.Text, { key: 'reset', dimColor: true }, ` · ${model.resetText}`))
  }
  if (model.checking === true) {
    children.push(React.createElement(ui.Text, { key: 'checking', dimColor: true }, ' ⋯'))
  }
  if (model.stale === true) {
    children.push(React.createElement(ui.Text, { key: 'stale', color: 'error' }, ' !'))
  }
  if (model.refreshing === true) {
    children.push(React.createElement(ui.Text, { key: 'refresh', dimColor: true }, ' ⟳'))
  }
  return children
}

/**
 * Create the component handed to `ctx.tuiStatus.registerView`.
 *
 * @param {{
 *   store: {subscribe: Function, getSnapshot: Function},
 *   getConfig: () => object,
 *   onRefresh: () => void
 * }} options
 * @returns {(props: {React: object, ui: object}) => object|null}
 */
export function createQuotaStatusView(options) {
  const { store, getConfig, onRefresh, activeStore } = options
  return function CodexQuotaStatusView({ React, ui }) {
    const state = React.useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
    const active = activeStore === undefined
      ? undefined
      : React.useSyncExternalStore(activeStore.subscribe, activeStore.getSnapshot, activeStore.getSnapshot)
    const terminal = ui.useTerminalSize()
    const model = buildStatusViewModel(state, getConfig(), {
      columns: terminal?.columns,
    })
    if (model === undefined) return null
    if (!isFamilyActive(active, PROVIDER_FAMILIES.CODEX)) return null
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
      ...buildQuotaChildren(React, ui, model),
    )
  }
}
