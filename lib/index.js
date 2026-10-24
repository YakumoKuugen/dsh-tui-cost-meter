/**
 * dsh-tui-cost-meter — Codex quota + DeepSeek cost/peak status lines.
 *
 * Contributions:
 *  - `ctx.tuiStatus.registerView` (seam XI): one rich row with a progress bar
 *    on the left and the remaining percentage on the right.
 *  - `ctx.tuiSettingsSections`: a "Codex Quota" panel in `/settings`.
 *
 * Data comes from the dsh-codex service when it is signed in (it owns token
 * refresh and proxy transport), otherwise from the dsh-auth / dsh-codex /
 * Codex CLI credential documents that dsh-tui's native Codex backend uses.
 */

import { Config, readConfig } from './config.js'
import { buildStatusViewModel, formatStatusText } from './quota.js'
import { createQuotaStatusView } from './view.js'
import { buildSettingsSection } from './settings.js'
import { QuotaPoller, QuotaStore } from './store.js'
import { fetchCodexUsage } from './usage-client.js'
import { readBestCredential } from './credentials.js'
import { buildDeepSeekViewModel, formatDeepSeekStatusText } from './deepseek.js'
import { createDeepSeekStatusView } from './deepseek-view.js'
import { DeepSeekPoller, DeepSeekStore } from './deepseek-store.js'
import { fetchDeepSeekBalance, readCostMeterLedger, readDeepSeekAccountBalance, readDeepSeekPlatformUsage, resolveDeepSeekApiKey } from './deepseek-client.js'

export { Config }

/** Stable plugin id; also the default settings namespace. */
export const name = 'dsh-tui-cost-meter'

const STATUS_KEY = 'dsh-tui-cost-meter'
const DEEPSEEK_STATUS_KEY = 'dsh-tui-cost-meter-deepseek'

function resolveSettingsNamespace(ctx) {
  const id = ctx.fiber?.entry?.options?.id
  if (typeof id === 'string' && /^[a-z][a-z0-9_-]*$/u.test(id)) return id
  ctx.logger?.warn?.(
    `[codex-quota] Loader id ${JSON.stringify(id)} is not a settings namespace; using ${name}`,
  )
  return name
}

function getCodexService(ctx) {
  try {
    return ctx.get('openAICodex')
  } catch {
    return undefined
  }
}

/**
 * Register the rich status view. If the host refuses rich views (older
 * dsh-tui), fall back to the scalar status line so the feature still works.
 */
function registerStatus(ctx, dependencies) {
  const { store, getConfig, poller } = dependencies

  ctx.inject(['tuiStatus'], statusCtx => {
    const component = createQuotaStatusView({
      store,
      getConfig,
      onRefresh: () => {
        void poller.refreshManually()
      },
    })

    const disposeView = statusCtx.tuiStatus.registerView(
      { key: STATUS_KEY, maxRows: 1, component },
      statusCtx,
    )

    if (disposeView !== undefined) {
      statusCtx.effect(() => disposeView, 'codex-quota status view')
    } else {
      const renderText = () => {
        const model = buildStatusViewModel(store.getSnapshot(), getConfig(), { columns: 80 })
        statusCtx.tuiStatus.set(
          STATUS_KEY,
          model === undefined ? undefined : formatStatusText(model),
          statusCtx,
        )
      }
      const unsubscribe = store.subscribe(renderText)
      renderText()
      statusCtx.effect(() => () => {
        unsubscribe()
        statusCtx.tuiStatus.set(STATUS_KEY, undefined, statusCtx)
      }, 'codex-quota status text')
    }

    statusCtx.effect(() => {
      poller.start()
      return () => poller.stop()
    }, 'codex-quota poller')
  })
}

/**
 * Register the DeepSeek balance/cost/peak row and start its clock.
 *
 * The row is registered even when disabled so a live `/settings` toggle can
 * bring it back without reloading the plugin row.
 */
function registerDeepSeekStatus(ctx, dependencies) {
  const { store, getConfig, poller } = dependencies

  ctx.inject(['tuiStatus'], statusCtx => {
    const component = createDeepSeekStatusView({
      store,
      getConfig,
      onRefresh: () => {
        void poller.refreshManually()
      },
    })

    const disposeView = statusCtx.tuiStatus.registerView(
      { key: DEEPSEEK_STATUS_KEY, maxRows: 2, component },
      statusCtx,
    )

    if (disposeView !== undefined) {
      statusCtx.effect(() => disposeView, 'deepseek-cost status view')
    } else {
      const renderText = () => {
        const model = buildDeepSeekViewModel(store.getSnapshot(), getConfig(), { columns: 80 })
        statusCtx.tuiStatus.set(
          DEEPSEEK_STATUS_KEY,
          model === undefined ? undefined : formatDeepSeekStatusText(model),
          statusCtx,
        )
      }
      const unsubscribe = store.subscribe(renderText)
      renderText()
      statusCtx.effect(() => () => {
        unsubscribe()
        statusCtx.tuiStatus.set(DEEPSEEK_STATUS_KEY, undefined, statusCtx)
      }, 'deepseek-cost status text')
    }

    statusCtx.effect(() => {
      poller.start()
      return () => poller.stop()
    }, 'deepseek-cost poller')
  })
}

/** Register the `/settings` section and hide the auto-generated page. */
function registerSettings(ctx) {
  ctx.inject(['tuiSettingsSections'], sectionsCtx => {
    const section = buildSettingsSection(resolveSettingsNamespace(ctx))
    const disposeSection = sectionsCtx.tuiSettingsSections.register(section)
    sectionsCtx.effect(() => disposeSection, 'codex-quota settings section')

    // Both contributions exist, so replacing the generic auto page with this
    // purpose-built panel cannot leave the namespace without any editor.
    ctx.inject(['settings'], settingsCtx => {
      settingsCtx.effect(() => {
        try {
          return settingsCtx.settings.configure({ auto: false }, ctx.fiber)
        } catch (error) {
          ctx.logger?.warn?.(`[codex-quota] settings page policy failed: ${error instanceof Error ? error.message : String(error)}`)
          return undefined
        }
      }, 'codex-quota settings page policy')
    })
  })
}

/**
 * Wire the plugin.
 *
 * @param {object} ctx - Cordis context
 * @param {object} [config] - validated plugin config (schema defaults applied)
 */
export function apply(ctx, config = {}) {
  const store = new QuotaStore()
  const getConfig = () => readConfig(config)
  const poller = new QuotaPoller({
    store,
    getConfig,
    getService: () => getCodexService(ctx),
    readCredential: () => readBestCredential(),
    fetchUsage: credential => fetchCodexUsage(credential),
    logger: ctx.logger,
  })

  const deepseekStore = new DeepSeekStore()
  const deepseekPoller = new DeepSeekPoller({
    store: deepseekStore,
    getConfig,
    readLedger: () => readCostMeterLedger(),
    readAccountBalance: now => readDeepSeekAccountBalance(ctx, now),
    readPlatformUsage: () => readDeepSeekPlatformUsage(ctx),
    resolveApiKey: () => resolveDeepSeekApiKey(ctx),
    fetchBalance: (key, options) => fetchDeepSeekBalance(key, options),
    notify: (text, color) => {
      try {
        const toast = ctx.get('tuiToast')
        if (toast !== undefined && typeof toast.show === 'function') {
          toast.show(text, { color, timeoutMs: 8000 })
        }
      } catch {
        // A host without the toast seam simply gets the inline notice.
      }
    },
    logger: ctx.logger,
  })

  // Live settings edits re-render immediately (the view reads config on every
  // render) and fetch once so a visibility/interval change takes effect now.
  ctx.effect(
    () => ctx.on('loader/volatile-update', () => {
      store.notify()
      poller.trigger()
      deepseekStore.notify()
      deepseekPoller.trigger()
    }),
    'codex-quota live settings',
  )

  registerStatus(ctx, { store, getConfig, poller })
  registerDeepSeekStatus(ctx, { store: deepseekStore, getConfig, poller: deepseekPoller })
  registerSettings(ctx)
}

