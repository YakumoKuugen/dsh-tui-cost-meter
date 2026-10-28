/**
 * Plugin configuration schema and live-value helpers.
 *
 * Every field is `.volatile()` on purpose: dsh-tui's settings screen can only
 * show a namespace whose schema has at least one live field, and live edits
 * must reach the status line without remounting the plugin row.
 */

import z from '@deepseek-ai/schemastery'

export const WINDOW_MODES = ['auto', 'fiveHour', 'weekly', 'shortest', 'longest']

/** MiniMax Token Plan windows the row can show. */
export const MINIMAX_WINDOW_MODES = ['auto', 'interval', 'weekly']

/** CommandCode usage windows the row can show. */
export const COMMANDCODE_WINDOW_MODES = ['auto', 'fiveHour', 'weekly']

/** Defaults, mirrored by {@link Config}. Kept plain so tests can read them. */
export const DEFAULTS = Object.freeze({
  enabled: true,
  window: 'auto',
  barWidth: 12,
  showLabel: true,
  showReset: false,
  showUnavailable: true,
  warnAt: 30,
  dangerAt: 10,
  refreshSeconds: 60,
  deepseekEnabled: true,
  deepseekShowBalance: true,
  deepseekShowToday: true,
  deepseekShowTotal: true,
  deepseekShowPeak: true,
  deepseekShowBar: true,
  deepseekBarWidth: 10,
  deepseekPeakNotify: true,
  deepseekRefreshSeconds: 300,
  minimaxEnabled: true,
  minimaxWindow: 'auto',
  minimaxBarWidth: 10,
  minimaxWarnAt: 30,
  minimaxDangerAt: 10,
  minimaxRefreshSeconds: 300,
  commandcodeEnabled: true,
  commandcodeWindow: 'auto',
  commandcodeBarWidth: 10,
  commandcodeWarnAt: 30,
  commandcodeDangerAt: 10,
  commandcodeShowCredits: true,
  commandcodeRefreshSeconds: 300,
})

/** Config schema exported to the Cordis loader and the settings service. */
export const Config = z
  .object({
    /** Draw the quota line at all. */
    enabled: z.boolean().default(DEFAULTS.enabled).volatile(),
    /** Which server window to show. */
    window: z.union(WINDOW_MODES).default(DEFAULTS.window).volatile(),
    /** Width of the progress bar in cells (clamped again for narrow terminals). */
    barWidth: z.number().step(1).min(4).max(40).default(DEFAULTS.barWidth).volatile(),
    /** Prefix the bar with the provider/window label. */
    showLabel: z.boolean().default(DEFAULTS.showLabel).volatile(),
    /** Append the time until the window resets. */
    showReset: z.boolean().default(DEFAULTS.showReset).volatile(),
    /** Show a dim placeholder when Codex is signed out or quota is unavailable. */
    showUnavailable: z.boolean().default(DEFAULTS.showUnavailable).volatile(),
    /** Remaining percentage at which the bar turns amber. */
    warnAt: z.number().step(1).min(0).max(100).default(DEFAULTS.warnAt).volatile(),
    /** Remaining percentage at which the bar turns red. */
    dangerAt: z.number().step(1).min(0).max(100).default(DEFAULTS.dangerAt).volatile(),
    /** Quota refresh cadence in seconds (the provider caches for 15s). */
    refreshSeconds: z.number().step(1).min(15).max(3600).default(DEFAULTS.refreshSeconds).volatile(),
    /** Draw the DeepSeek balance/cost line. */
    deepseekEnabled: z.boolean().default(DEFAULTS.deepseekEnabled).volatile(),
    /** Show the official open-platform balance. */
    deepseekShowBalance: z.boolean().default(DEFAULTS.deepseekShowBalance).volatile(),
    /** Show today's recorded DeepSeek API cost. */
    deepseekShowToday: z.boolean().default(DEFAULTS.deepseekShowToday).volatile(),
    /** Show the all-retained-history DeepSeek API cost. */
    deepseekShowTotal: z.boolean().default(DEFAULTS.deepseekShowTotal).volatile(),
    /** Show the peak/off-peak phase and countdown. */
    deepseekShowPeak: z.boolean().default(DEFAULTS.deepseekShowPeak).volatile(),
    /** Draw the remaining/today/used balance bar. */
    deepseekShowBar: z.boolean().default(DEFAULTS.deepseekShowBar).volatile(),
    /** Width of the DeepSeek balance bar in cells. */
    deepseekBarWidth: z.number().step(1).min(4).max(30).default(DEFAULTS.deepseekBarWidth).volatile(),
    /** Show a toast when the peak/off-peak phase changes. */
    deepseekPeakNotify: z.boolean().default(DEFAULTS.deepseekPeakNotify).volatile(),
    /** DeepSeek ledger/balance refresh cadence in seconds. */
    deepseekRefreshSeconds: z.number().step(1).min(30).max(3600).default(DEFAULTS.deepseekRefreshSeconds).volatile(),
    /** Draw the MiniMax Token Plan quota line. */
    minimaxEnabled: z.boolean().default(DEFAULTS.minimaxEnabled).volatile(),
    /** Which MiniMax window to show. */
    minimaxWindow: z.union(MINIMAX_WINDOW_MODES).default(DEFAULTS.minimaxWindow).volatile(),
    /** Width of the MiniMax quota bar in cells. */
    minimaxBarWidth: z.number().step(1).min(4).max(24).default(DEFAULTS.minimaxBarWidth).volatile(),
    /** Remaining percentage at which the MiniMax bar turns amber. */
    minimaxWarnAt: z.number().step(1).min(0).max(100).default(DEFAULTS.minimaxWarnAt).volatile(),
    /** Remaining percentage at which the MiniMax bar turns red. */
    minimaxDangerAt: z.number().step(1).min(0).max(100).default(DEFAULTS.minimaxDangerAt).volatile(),
    /** MiniMax quota refresh cadence in seconds. */
    minimaxRefreshSeconds: z.number().step(1).min(30).max(3600).default(DEFAULTS.minimaxRefreshSeconds).volatile(),
    /** Draw the CommandCode plan quota line. */
    commandcodeEnabled: z.boolean().default(DEFAULTS.commandcodeEnabled).volatile(),
    /** Which CommandCode window to show. */
    commandcodeWindow: z.union(COMMANDCODE_WINDOW_MODES).default(DEFAULTS.commandcodeWindow).volatile(),
    /** Width of the CommandCode quota bar in cells. */
    commandcodeBarWidth: z.number().step(1).min(4).max(24).default(DEFAULTS.commandcodeBarWidth).volatile(),
    /** Remaining percentage at which the CommandCode bar turns amber. */
    commandcodeWarnAt: z.number().step(1).min(0).max(100).default(DEFAULTS.commandcodeWarnAt).volatile(),
    /** Remaining percentage at which the CommandCode bar turns red. */
    commandcodeDangerAt: z.number().step(1).min(0).max(100).default(DEFAULTS.commandcodeDangerAt).volatile(),
    /** Append the monthly credits wallet to the row. */
    commandcodeShowCredits: z.boolean().default(DEFAULTS.commandcodeShowCredits).volatile(),
    /** CommandCode quota refresh cadence in seconds. */
    commandcodeRefreshSeconds: z.number().step(1).min(30).max(3600).default(DEFAULTS.commandcodeRefreshSeconds).volatile(),
  })
  .description('Codex quota status line')

/**
 * Read a Cordis volatile config value.
 *
 * A volatile schema field arrives as a `{ get() }` handle; ordinary fields
 * arrive as plain values. Treating both shapes uniformly keeps the hot path
 * allocation-free and avoids remount-on-change.
 *
 * @param {unknown} value - live field value or volatile handle
 * @param {unknown} fallback - value used when the field is absent
 * @returns {unknown} current value
 */
export function liveValue(value, fallback) {
  if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
    try {
      const resolved = value.get()
      return resolved === undefined ? fallback : resolved
    } catch {
      return fallback
    }
  }
  return value === undefined ? fallback : value
}

/** Clamp an integer into an inclusive range. */
export function clampInt(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(number)))
}

/**
 * Resolve the live display configuration.
 *
 * @param {object|undefined} config - plugin config passed by the loader
 * @returns {{
 *   enabled: boolean, window: string, barWidth: number, showLabel: boolean,
 *   showReset: boolean, showUnavailable: boolean, warnAt: number,
 *   dangerAt: number, refreshSeconds: number, deepseekEnabled: boolean,
 *   deepseekShowBalance: boolean, deepseekShowToday: boolean,
 *   deepseekShowTotal: boolean, deepseekShowPeak: boolean,
 *   deepseekShowBar: boolean, deepseekBarWidth: number,
 *   deepseekPeakNotify: boolean, deepseekRefreshSeconds: number,
 *   minimaxEnabled: boolean, minimaxWindow: string, minimaxBarWidth: number,
 *   minimaxWarnAt: number, minimaxDangerAt: number, minimaxRefreshSeconds: number,
 *   commandcodeEnabled: boolean, commandcodeWindow: string,
 *   commandcodeBarWidth: number, commandcodeWarnAt: number,
 *   commandcodeDangerAt: number, commandcodeShowCredits: boolean,
 *   commandcodeRefreshSeconds: number
 * }}
 */
export function readConfig(config = {}) {
  const window = liveValue(config.window, DEFAULTS.window)
  return {
    enabled: liveValue(config.enabled, DEFAULTS.enabled) !== false,
    window: WINDOW_MODES.includes(window) ? window : DEFAULTS.window,
    barWidth: clampInt(liveValue(config.barWidth, DEFAULTS.barWidth), 4, 40, DEFAULTS.barWidth),
    showLabel: liveValue(config.showLabel, DEFAULTS.showLabel) !== false,
    showReset: liveValue(config.showReset, DEFAULTS.showReset) === true,
    showUnavailable: liveValue(config.showUnavailable, DEFAULTS.showUnavailable) !== false,
    warnAt: clampInt(liveValue(config.warnAt, DEFAULTS.warnAt), 0, 100, DEFAULTS.warnAt),
    dangerAt: clampInt(liveValue(config.dangerAt, DEFAULTS.dangerAt), 0, 100, DEFAULTS.dangerAt),
    refreshSeconds: clampInt(liveValue(config.refreshSeconds, DEFAULTS.refreshSeconds), 15, 3600, DEFAULTS.refreshSeconds),
    deepseekEnabled: liveValue(config.deepseekEnabled, DEFAULTS.deepseekEnabled) !== false,
    deepseekShowBalance: liveValue(config.deepseekShowBalance, DEFAULTS.deepseekShowBalance) !== false,
    deepseekShowToday: liveValue(config.deepseekShowToday, DEFAULTS.deepseekShowToday) !== false,
    deepseekShowTotal: liveValue(config.deepseekShowTotal, DEFAULTS.deepseekShowTotal) !== false,
    deepseekShowPeak: liveValue(config.deepseekShowPeak, DEFAULTS.deepseekShowPeak) !== false,
    deepseekShowBar: liveValue(config.deepseekShowBar, DEFAULTS.deepseekShowBar) !== false,
    deepseekBarWidth: clampInt(liveValue(config.deepseekBarWidth, DEFAULTS.deepseekBarWidth), 4, 30, DEFAULTS.deepseekBarWidth),
    deepseekPeakNotify: liveValue(config.deepseekPeakNotify, DEFAULTS.deepseekPeakNotify) !== false,
    deepseekRefreshSeconds: clampInt(
      liveValue(config.deepseekRefreshSeconds, DEFAULTS.deepseekRefreshSeconds),
      30,
      3600,
      DEFAULTS.deepseekRefreshSeconds,
    ),
    minimaxEnabled: liveValue(config.minimaxEnabled, DEFAULTS.minimaxEnabled) !== false,
    minimaxWindow: MINIMAX_WINDOW_MODES.includes(liveValue(config.minimaxWindow, DEFAULTS.minimaxWindow))
      ? liveValue(config.minimaxWindow, DEFAULTS.minimaxWindow)
      : DEFAULTS.minimaxWindow,
    minimaxBarWidth: clampInt(liveValue(config.minimaxBarWidth, DEFAULTS.minimaxBarWidth), 4, 24, DEFAULTS.minimaxBarWidth),
    minimaxWarnAt: clampInt(liveValue(config.minimaxWarnAt, DEFAULTS.minimaxWarnAt), 0, 100, DEFAULTS.minimaxWarnAt),
    minimaxDangerAt: clampInt(liveValue(config.minimaxDangerAt, DEFAULTS.minimaxDangerAt), 0, 100, DEFAULTS.minimaxDangerAt),
    minimaxRefreshSeconds: clampInt(
      liveValue(config.minimaxRefreshSeconds, DEFAULTS.minimaxRefreshSeconds),
      30,
      3600,
      DEFAULTS.minimaxRefreshSeconds,
    ),
    commandcodeEnabled: liveValue(config.commandcodeEnabled, DEFAULTS.commandcodeEnabled) !== false,
    commandcodeWindow: COMMANDCODE_WINDOW_MODES.includes(liveValue(config.commandcodeWindow, DEFAULTS.commandcodeWindow))
      ? liveValue(config.commandcodeWindow, DEFAULTS.commandcodeWindow)
      : DEFAULTS.commandcodeWindow,
    commandcodeBarWidth: clampInt(
      liveValue(config.commandcodeBarWidth, DEFAULTS.commandcodeBarWidth),
      4,
      24,
      DEFAULTS.commandcodeBarWidth,
    ),
    commandcodeWarnAt: clampInt(
      liveValue(config.commandcodeWarnAt, DEFAULTS.commandcodeWarnAt),
      0,
      100,
      DEFAULTS.commandcodeWarnAt,
    ),
    commandcodeDangerAt: clampInt(
      liveValue(config.commandcodeDangerAt, DEFAULTS.commandcodeDangerAt),
      0,
      100,
      DEFAULTS.commandcodeDangerAt,
    ),
    commandcodeShowCredits: liveValue(config.commandcodeShowCredits, DEFAULTS.commandcodeShowCredits) !== false,
    commandcodeRefreshSeconds: clampInt(
      liveValue(config.commandcodeRefreshSeconds, DEFAULTS.commandcodeRefreshSeconds),
      30,
      3600,
      DEFAULTS.commandcodeRefreshSeconds,
    ),
  }
}
