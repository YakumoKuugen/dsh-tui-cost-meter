/**
 * Declarative settings section for dsh-tui's `/settings` screen.
 *
 * The screen owns rendering and staged writes; this module only says which
 * fields exist. Paths match the volatile Config schema one-for-one, so a
 * committed edit reaches the live status line without a restart.
 */

const GROUPS = [
  { id: 'display', title: 'Display', zh: '显示' },
  { id: 'bar', title: 'Bar & colors', zh: '进度条与颜色' },
  { id: 'refresh', title: 'Refresh', zh: '刷新' },
  { id: 'deepseek', title: 'DeepSeek costs', zh: 'DeepSeek 费用' },
  { id: 'minimax', title: 'MiniMax quota', zh: 'MiniMax 额度' },
]

function localized(en, zh) {
  return { en, zh }
}

function numberField(key, labelEn, labelZh, group, min, max, hintEn, hintZh) {
  return {
    path: [key],
    kind: 'number',
    label: labelEn,
    descriptions: localized(labelEn, labelZh),
    group,
    ...(hintEn === undefined ? {} : {
      hint: hintEn,
      hintDescriptions: localized(hintEn, hintZh),
    }),
    format(value) {
      return typeof value === 'number' && Number.isFinite(value) ? String(value) : ''
    },
    parse(text) {
      const trimmed = text.trim()
      if (trimmed === '') return { kind: 'clear' }
      const value = Number(trimmed)
      if (!Number.isInteger(value) || value < min || value > max) return undefined
      return { kind: 'set', value }
    },
  }
}

/**
 * Build the section registered under the plugin row's settings namespace.
 *
 * @param {string} namespace - the row id / settings namespace
 * @returns {object} dsh-tui `TuiSettingsSection`
 */
export function buildSettingsSection(namespace) {
  return {
    ns: namespace,
    title: 'Codex & DeepSeek',
    descriptions: localized('Codex & DeepSeek', 'Codex 与 DeepSeek'),
    groups: GROUPS.map(group => ({
      id: group.id,
      title: group.title,
      descriptions: localized(group.title, group.zh),
    })),
    fields: [
      {
        path: ['enabled'],
        kind: 'boolean',
        label: 'Show quota in status line',
        descriptions: localized('Show quota in status line', '在底栏显示额度'),
        group: 'display',
      },
      {
        path: ['window'],
        kind: 'select',
        label: 'Quota window',
        descriptions: localized('Quota window', '额度窗口'),
        group: 'display',
        hint: 'Auto prefers the 5-hour window, then the shortest window the plan exposes.',
        hintDescriptions: localized(
          'Auto prefers the 5-hour window, then the shortest window the plan exposes.',
          '自动优先 5 小时窗口；没有时使用套餐提供的最短窗口。',
        ),
        options: [
          { value: 'auto', label: 'Auto', descriptions: localized('Auto', '自动') },
          { value: 'fiveHour', label: '5 hours', descriptions: localized('5 hours', '5 小时') },
          { value: 'weekly', label: 'Weekly', descriptions: localized('Weekly', '每周') },
          { value: 'shortest', label: 'Shortest', descriptions: localized('Shortest', '最短窗口') },
          { value: 'longest', label: 'Longest', descriptions: localized('Longest', '最长窗口') },
        ],
      },
      {
        path: ['showLabel'],
        kind: 'boolean',
        label: 'Show provider/window label',
        descriptions: localized('Show provider/window label', '显示 Codex 与窗口标签'),
        group: 'display',
      },
      {
        path: ['showReset'],
        kind: 'boolean',
        label: 'Show reset countdown',
        descriptions: localized('Show reset countdown', '显示重置倒计时'),
        group: 'display',
      },
      {
        path: ['showUnavailable'],
        kind: 'boolean',
        label: 'Show placeholder when unavailable',
        descriptions: localized('Show placeholder when unavailable', '不可用时显示占位提示'),
        group: 'display',
        hint: 'A dim hint appears when Codex is signed out, the login expired, or the quota cannot be read.',
        hintDescriptions: localized(
          'A dim hint appears when Codex is signed out, the login expired, or the quota cannot be read.',
          'Codex 未登录、登录过期或额度读取失败时显示一条暗色提示。',
        ),
      },
      numberField(
        'barWidth',
        'Progress bar width',
        '进度条宽度',
        'bar',
        4,
        40,
        'Cells, 4–40. Narrow terminals shrink the bar automatically.',
        '字符数，4–40；终端较窄时会自动缩短。',
      ),
      numberField(
        'warnAt',
        'Amber below (%)',
        '低于多少变黄 (%)',
        'bar',
        0,
        100,
        'Remaining percentage at which the bar turns amber.',
        '剩余百分比低于该值时进度条变黄。',
      ),
      numberField(
        'dangerAt',
        'Red below (%)',
        '低于多少变红 (%)',
        'bar',
        0,
        100,
        'Remaining percentage at which the bar turns red.',
        '剩余百分比低于该值时进度条变红。',
      ),
      numberField(
        'refreshSeconds',
        'Refresh interval (seconds)',
        '刷新间隔（秒）',
        'refresh',
        15,
        3600,
        'Minimum 15 seconds; the Codex provider caches usage for 15 seconds.',
        '最少 15 秒；Codex 服务端会缓存额度数据 15 秒。',
      ),
      {
        path: ['deepseekEnabled'],
        kind: 'boolean',
        label: 'Show DeepSeek cost line',
        descriptions: localized('Show DeepSeek cost line', '显示 DeepSeek 费用行'),
        group: 'deepseek',
        hint: 'Reads the dsh-cost-meter ledger and the official DeepSeek balance. The line is hidden when off.',
        hintDescriptions: localized(
          'Reads the dsh-cost-meter ledger and the official DeepSeek balance. The line is hidden when off.',
          '读取 dsh-cost-meter 账本与 DeepSeek 官方余额；关闭后不显示这一行。',
        ),
      },
      {
        path: ['deepseekShowBalance'],
        kind: 'boolean',
        label: 'Show DeepSeek balance',
        descriptions: localized('Show DeepSeek balance', '显示 DeepSeek 余额'),
        group: 'deepseek',
        hint: 'Uses DEEPSEEK_BALANCE_API_KEY, then DEEPSEEK_API_KEY. A missing key shows a dash instead of failing the line.',
        hintDescriptions: localized(
          'Uses DEEPSEEK_BALANCE_API_KEY, then DEEPSEEK_API_KEY. A missing key shows a dash instead of failing the line.',
          '优先使用 DEEPSEEK_BALANCE_API_KEY，其次 DEEPSEEK_API_KEY；没有 Key 时显示 —，不影响其他信息。',
        ),
      },
      {
        path: ['deepseekShowToday'],
        kind: 'boolean',
        label: "Show today's DeepSeek cost",
        descriptions: localized("Show today's DeepSeek cost", '显示 DeepSeek 今日费用'),
        group: 'deepseek',
      },
      {
        path: ['deepseekShowTotal'],
        kind: 'boolean',
        label: "Show this month's DeepSeek cost",
        descriptions: localized("Show this month's DeepSeek cost", '显示 DeepSeek 本月费用'),
        group: 'deepseek',
        hint: "Fetched from DeepSeek Platform's monthly usage when signed in; falls back to the current month in the dsh-cost-meter ledger.",
        hintDescriptions: localized(
          "Fetched from DeepSeek Platform's monthly usage when signed in; falls back to the current month in the dsh-cost-meter ledger.",
          '登录 DeepSeek 平台时读取后台本月消费；读取失败时回退到 dsh-cost-meter 账本的当月合计。',
        ),
      },
      {
        path: ['deepseekShowPeak'],
        kind: 'boolean',
        label: 'Show peak/off-peak countdown',
        descriptions: localized('Show peak/off-peak countdown', '显示峰谷倒计时'),
        group: 'deepseek',
        hint: 'Peak windows and holidays come from the dsh-cost-meter ledger config; weekends are all off-peak.',
        hintDescriptions: localized(
          'Peak windows and holidays come from the dsh-cost-meter ledger config; weekends are all off-peak.',
          '峰时窗口与节假日取自 dsh-cost-meter 配置；周末全天为平价。',
        ),
      },
      {
        path: ['deepseekShowBar'],
        kind: 'boolean',
        label: 'Show balance usage bar',
        descriptions: localized('Show balance usage bar', '显示余额使用条'),
        group: 'deepseek',
        hint: 'A compact remaining/today/prior-used bar; the denominator is balance + recorded spend.',
        hintDescriptions: localized(
          'A compact remaining/today/prior-used bar; the denominator is balance + recorded spend.',
          '紧凑的“剩余/今日/此前已用”条；总长度按余额 + 已记录费用近似。',
        ),
      },
      numberField(
        'deepseekBarWidth',
        'Balance bar width',
        '余额条宽度',
        'deepseek',
        4,
        30,
        'Cells, 4–30; narrow terminals drop the bar before the numbers.',
        '字符数，4–30；终端较窄时会先省略这条进度条。',
      ),
      {
        path: ['deepseekPeakNotify'],
        kind: 'boolean',
        label: 'Toast when peak switches',
        descriptions: localized('Toast when peak switches', '峰谷切换时弹提示'),
        group: 'deepseek',
        hint: 'Shows a transient toast at the exact switch, in addition to the 60s inline notice.',
        hintDescriptions: localized(
          'Shows a transient toast at the exact switch, in addition to the 60s inline notice.',
          '切换时刻弹出一次性提示，状态行同时显示 60 秒的切换提示。',
        ),
      },
      {
        path: ['minimaxEnabled'],
        kind: 'boolean',
        label: 'Show MiniMax quota line',
        descriptions: localized('Show MiniMax quota line', '显示 MiniMax 额度行'),
        group: 'minimax',
        hint: 'Reads the MiniMax Token Plan quota. The line is hidden when off.',
        hintDescriptions: localized(
          'Reads the MiniMax Token Plan quota. The line is hidden when off.',
          '读取 MiniMax Token Plan 额度；关闭后不显示这一行。',
        ),
      },
      {
        path: ['minimaxWindow'],
        kind: 'select',
        label: 'MiniMax quota window',
        descriptions: localized('MiniMax quota window', 'MiniMax 额度窗口'),
        group: 'minimax',
        hint: 'Auto shows the current 5-hour window, then the weekly one.',
        hintDescriptions: localized(
          'Auto shows the current 5-hour window, then the weekly one.',
          '自动优先显示当前 5 小时窗口，其次是本周窗口。',
        ),
        options: [
          { value: 'auto', label: 'Auto', descriptions: localized('Auto', '自动') },
          { value: 'interval', label: '5 hours', descriptions: localized('5 hours', '5 小时') },
          { value: 'weekly', label: 'Weekly', descriptions: localized('Weekly', '每周') },
        ],
      },
      numberField(
        'minimaxBarWidth',
        'MiniMax bar width',
        'MiniMax 进度条宽度',
        'minimax',
        4,
        24,
        'Cells, 4–24.',
        '字符数，4–24。',
      ),
      numberField(
        'minimaxWarnAt',
        'MiniMax amber below (%)',
        'MiniMax 低于多少变黄 (%)',
        'minimax',
        0,
        100,
        'Remaining percentage at which the MiniMax bar turns amber.',
        '剩余百分比低于该值时 MiniMax 进度条变黄。',
      ),
      numberField(
        'minimaxDangerAt',
        'MiniMax red below (%)',
        'MiniMax 低于多少变红 (%)',
        'minimax',
        0,
        100,
        'Remaining percentage at which the MiniMax bar turns red.',
        '剩余百分比低于该值时 MiniMax 进度条变红。',
      ),
      numberField(
        'minimaxRefreshSeconds',
        'MiniMax refresh interval (seconds)',
        'MiniMax 刷新间隔（秒）',
        'minimax',
        30,
        3600,
        'Quota refresh cadence; minimum 30 seconds.',
        '额度刷新间隔，最少 30 秒。',
      ),
      numberField(
        'deepseekRefreshSeconds',
        'DeepSeek refresh interval (seconds)',
        'DeepSeek 刷新间隔（秒）',
        'deepseek',
        30,
        3600,
        'Ledger and balance refresh; the peak clock still ticks every 30 seconds.',
        '账本与余额的刷新间隔；峰谷时钟仍每 30 秒更新一次。',
      ),
    ],
  }
}
