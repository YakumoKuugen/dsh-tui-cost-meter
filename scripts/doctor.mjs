#!/usr/bin/env node
/**
 * Cross-platform doctor for dsh-tui-cost-meter.
 *
 * Answers the two support questions that cannot be answered from a screenshot:
 *  1. which version is actually loaded, and is it wired into the profile?
 *  2. which billing module should the status line show right now, and why?
 *
 * Read-only: it never writes a file and never prints a secret. Everything it
 * prints is either a version, a path, a provider id, or a masked key.
 *
 * Usage:
 *   node scripts/doctor.mjs [--profile dsh-tui] [--json]
 */

import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const argv = process.argv.slice(2)
const json = argv.includes('--json')
const profileFlag = argv.indexOf('--profile')
const profile = profileFlag !== -1 && argv[profileFlag + 1] !== undefined
  ? argv[profileFlag + 1]
  : 'dsh-tui'

const scriptPath = fileURLToPath(import.meta.url)
const packagePath = join(dirname(scriptPath), '..', 'package.json')

const home = homedir()
const profileDir = join(home, '.dsh', 'profiles', profile)
// dsh-tui hard-codes `~/.dsh-tui` (utils/paths.js ignores env overrides), so
// the doctor must inspect exactly that path — a stale DSH_TUI_HOME is itself a
// classic cause of "the row never follows /model".
const tuiHome = join(home, '.dsh-tui')
const dshHome = process.env.DSH_HOME !== undefined && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : join(home, '.dsh')

const report = {
  platform: `${process.platform} ${process.arch}`,
  node: process.version,
  engines: {},
  plugin: {},
  profile: { dir: profileDir, problems: [] },
  route: {},
  credentials: {},
  verdict: [],
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function installedPackage(name) {
  const path = join(profileDir, 'node_modules', name, 'package.json')
  return readJson(path)
}

function mask(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return `${value.slice(0, 4)}…(${value.length} chars)`
}

/* ---------------------------------------------------------------- plugin */

const ownPkg = readJson(packagePath)
report.plugin.version = ownPkg?.version
report.plugin.path = packagePath

const installed = installedPackage('dsh-tui-cost-meter')
report.plugin.installedVersion = installed?.version
report.plugin.installed = installed !== undefined

/* -------------------------------------------------------------- engines */

const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number)
report.engines.node = ownPkg?.engines?.node
report.engines.nodeOk = nodeMajor >= 24 || (nodeMajor === 22 && nodeMinor >= 19)

/* --------------------------------------------------------------- profile */

const profilePkg = readJson(join(profileDir, 'package.json'))
report.profile.exists = profilePkg !== undefined
if (profilePkg === undefined) {
  report.profile.problems.push(`找不到 profile：${join(profileDir, 'package.json')}`)
} else {
  const deps = profilePkg.dependencies ?? {}
  report.profile.dependencies = deps
  report.profile.bundles = profilePkg.dsh?.profile?.bundles ?? []

  for (const [name, spec] of Object.entries(deps)) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue
    const target = spec.slice('file:'.length)
    if (!existsSync(target)) {
      report.profile.problems.push(`依赖 ${name} 指向的本地文件不存在：${target}`)
    }
  }

  if (!Object.keys(deps).some(name => name === 'dsh-tui-cost-meter')) {
    report.profile.problems.push('profile 依赖里没有 dsh-tui-cost-meter（插件未安装）')
  }
  if (!report.profile.bundles.includes('dsh-tui-cost-meter')) {
    report.profile.problems.push('profile bundles 里没有 dsh-tui-cost-meter（插件不会被加载）')
  }
  if (Object.keys(deps).some(name => name === 'dsh-tui-codex-quota')) {
    report.profile.problems.push('还装着旧包 dsh-tui-codex-quota，它会继续渲染 Codex 行，建议 remove')
  }
  for (const legacy of ['dsh-tui-codex-quota']) {
    if (Object.keys(deps).includes(legacy) && !report.profile.problems.some(p => p.includes(legacy))) {
      report.profile.problems.push(`旧包 ${legacy} 仍在依赖里`)
    }
  }
}

if (installed !== undefined && ownPkg?.version !== undefined && installed.version !== ownPkg.version) {
  report.profile.problems.push(
    `安装的版本 ${installed.version} 与脚本版本 ${ownPkg.version} 不一致（脚本可能不是同一份代码）`,
  )
}

/* ----------------------------------------------------------------- route */

const modelPath = join(tuiHome, 'model.json')
report.route.modelJson = modelPath
report.route.dshTuiHome = process.env.DSH_TUI_HOME ?? null
if (report.route.dshTuiHome !== null) {
  report.profile.problems.push(
    `设置了 DSH_TUI_HOME=${report.route.dshTuiHome}，但 dsh-tui 不读这个变量（固定 ~/.dsh-tui）；`
    + '旧版插件会读它并一直显示旧模型，升级到 0.5.1+ 可修正',
  )
}
const modelPref = readJson(modelPath)
if (modelPref === undefined) {
  report.route.exists = false
  report.route.note = '没有 model.json：dsh-tui 还没用 /model 选过模型，三个模块都会显示'
} else {
  report.route.exists = true
  report.route.provider = modelPref.provider
  report.route.model = modelPref.model
  const id = String(modelPref.provider ?? '').toLowerCase().replace(/^llm-/, '')
  report.route.family = id === 'openai-codex' || id === 'codex' || id.startsWith('openai-codex')
    ? 'codex'
    : id === 'minimax' || id.startsWith('minimax-')
      ? 'minimax'
      : id === 'deepseek' || id.startsWith('deepseek-') || id.endsWith('-deepseek')
        ? 'deepseek'
        : undefined
  report.route.note = report.route.family === undefined
    ? 'provider 无法识别：三个模块都会显示'
    : `只显示 ${report.route.family} 模块`

  try {
    const ageMs = Date.now() - statSync(modelPath).mtimeMs
    report.route.ageHours = Math.round(ageMs / 3_600_000)
    const activityPath = join(tuiHome, 'last-used.json')
    if (existsSync(activityPath)) {
      const activityAgeHours = Math.round((Date.now() - statSync(activityPath).mtimeMs) / 3_600_000)
      report.route.activityAgeHours = activityAgeHours
      if (report.route.ageHours > 72 && activityAgeHours < report.route.ageHours) {
        report.route.stale = true
        report.route.note += `；但 model.json 已经 ${report.route.ageHours} 小时没更新，`
          + '而宿主最近还在用——/model 可能写不进这个文件'
      }
    }
  } catch {
    // A stat failure is not worth failing the report over.
  }
}

try {
  accessSync(tuiHome, constants.W_OK)
  report.route.dataDirWritable = true
} catch {
  report.route.dataDirWritable = false
}

/* ----------------------------------------------------------- credentials */

const credentialFile = join(dshHome, '.credentials.yaml')
report.credentials.file = credentialFile
report.credentials.fileExists = existsSync(credentialFile)

let credentialText = ''
try {
  credentialText = readFileSync(credentialFile, 'utf8')
} catch {
  // Missing/unreadable document is a normal state.
}

const envNames = [
  'MINIMAX_CN_API_KEY',
  'MINIMAX_API_KEY',
  'DEEPSEEK_BALANCE_API_KEY',
  'DEEPSEEK_API_KEY',
]
report.credentials.env = {}
for (const name of envNames) {
  report.credentials.env[name] = mask(process.env[name]) ?? null
}

report.credentials.inFile = {}
for (const name of envNames) {
  const hit = new RegExp(`^\\s*${name}\\s*:\\s*(.+)$`, 'mu').exec(credentialText)
  report.credentials.inFile[name] = hit?.[1] !== undefined ? mask(hit[1].trim().replace(/^["']|["']$/gu, '')) : null
}

report.credentials.ledger = join(dshHome, 'storages', 'cost-meter', 'ledger.json')
report.credentials.ledgerExists = existsSync(report.credentials.ledger)

/* --------------------------------------------------------- install logs */

report.install = { log: undefined, tail: [] }
const logsDir = join(profileDir, '.plugin-manager', 'logs')
try {
  const dirs = readdirSync(logsDir)
    .map(name => ({ name, path: join(logsDir, name), at: statSync(join(logsDir, name)).mtimeMs }))
    .filter(entry => statSync(entry.path).isDirectory())
    .sort((a, b) => b.at - a.at)
  for (const entry of dirs) {
    const logPath = join(entry.path, 'pnpm.log')
    if (!existsSync(logPath)) continue
    const text = readFileSync(logPath, 'utf8')
    report.install.log = logPath
    report.install.tail = text
      .split(/\r?\n/u)
      .slice(-30)
      .map(line => line.replace(/sk-[A-Za-z0-9_-]{6,}/gu, 'sk-***').replace(/Bearer\s+\S+/gu, 'Bearer ***'))
    break
  }
} catch {
  // No plugin-manager logs yet: a fresh profile.
}

const logText = report.install.tail.join('\n')
report.install.hints = []
if (/EBADENGINE|Unsupported engine/iu.test(logText)) {
  report.install.hints.push('安装日志里有 engines 不匹配（Node 版本太低）：升到 Node 22.19+ 或 24+')
}
if (/EPERM|EACCES/iu.test(logText)) {
  report.install.hints.push('安装日志里有 EPERM/EACCES：Windows 下多为 pnpm 建符号链接失败，开启“开发者模式”或用管理员终端重试')
}
if (/peer dependenc/iu.test(logText)) {
  report.install.hints.push('安装日志里有 peer dependency 警告：通常只是 WARN；若安装被拒绝，看下一行的 rejected 原因')
}
if (/installation rejected|incompatible with dsh/iu.test(logText)) {
  report.install.hints.push('安装被 dsh 的兼容性检查拒绝：日志里有 exact requirements，需要换插件版本或用 dsh plugin allow-version')
}
if (/ENOENT.*\.tgz|no such file.*\.tgz/iu.test(logText)) {
  report.install.hints.push('安装日志里有找不到本地 tarball：profile 里残留了 file: 依赖，先 remove 再重装')
}

/* --------------------------------------------------------------- verdict */

if (installed === undefined) {
  report.verdict.push('插件没装进 profile：先执行 dsh plugin --profile dsh-tui add <tarball 或 github:…>')
} else if (report.plugin.installedVersion !== undefined
  && report.plugin.installedVersion.localeCompare('0.5.0', undefined, { numeric: true }) < 0) {
  report.verdict.push(`安装的是 ${report.plugin.installedVersion}，没有 MiniMax 行和“跟随当前模型”能力；升级到 0.5.0+`)
}
if (report.profile.problems.length > 0) {
  report.verdict.push('先修掉 profile 问题（见 profile.problems），否则重装也不会生效')
}
if (installed !== undefined && !report.profile.bundles.includes('dsh-tui-cost-meter')) {
  report.verdict.push('插件已下载但没进 bundles：重新执行一次 dsh plugin add 让安装器写回 bundles')
}
if (report.engines.nodeOk === false) {
  report.verdict.push(`当前 Node ${report.node} 不满足插件 engines（${report.engines.node}）：请升级 Node`)
}
for (const hint of report.install.hints ?? []) report.verdict.push(hint)
if (report.route.dataDirWritable === false) {
  report.verdict.push(`写不进 ${tuiHome}：/model 的选择无法保存，状态行会一直停在旧模型；检查目录权限或杀毒软件拦截`)
}
if (report.route.stale === true) {
  report.verdict.push('model.json 长期没更新（见 route.note）：切一次 /model，看是否弹出“无法写入 ~/.dsh-tui/model.json”')
}
if (report.route.exists && report.route.family === 'codex' && installed?.version?.startsWith('0.5')) {
  report.verdict.push('当前按 model.json 只显示 Codex；如果会话里其实在用别的模型，说明该文件没跟着更新——用 /model 重新选一次，或在 dsh-tui 里确认能写入 ~/.dsh-tui')
}

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  process.exit(0)
}

const line = (label, value) => {
  process.stdout.write(`${label.padEnd(22)}${value === undefined || value === null ? '—' : value}\n`)
}

process.stdout.write('\n=== dsh-tui-cost-meter doctor ===\n\n')
line('系统', report.platform)
line('Node', report.node)
line('脚本版本', report.plugin.version)
line('已安装版本', report.plugin.installedVersion)
line('插件目录', join(profileDir, 'node_modules', 'dsh-tui-cost-meter'))
line('profile', profileDir)

process.stdout.write('\n--- profile 检查\n')
if (report.profile.problems.length === 0) {
  process.stdout.write('  ✓ 依赖、bundles、本地路径都正常\n')
} else {
  for (const problem of report.profile.problems) process.stdout.write(`  ✗ ${problem}\n`)
}
if (Array.isArray(report.profile.bundles)) {
  line('bundles', report.profile.bundles.join(', '))
}

process.stdout.write('\n--- 当前模型路由\n')
line('model.json', modelPath)
line('存在', report.route.exists ? '是' : '否')
line('provider', report.route.provider)
line('model', report.route.model)
line('家族', report.route.family)
line('model.json 年龄', report.route.ageHours === undefined ? undefined : `${report.route.ageHours} 小时`)
line('数据目录可写', report.route.dataDirWritable === undefined
  ? undefined
  : (report.route.dataDirWritable ? '是' : '否（在 dsh 沙箱里跑会误报，请在普通终端重跑）'))
if (report.route.note !== undefined) process.stdout.write(`  → ${report.route.note}\n`)

process.stdout.write('\n--- 安装日志\n')
if (report.install.log === undefined) {
  process.stdout.write('  （没有 plugin-manager 日志）\n')
} else {
  line('最新日志', report.install.log)
  for (const hint of report.install.hints) process.stdout.write(`  • ${hint}\n`)
  process.stdout.write('  --- 末尾 30 行 ---\n')
  for (const row of report.install.tail) process.stdout.write(`  ${row}\n`)
}

process.stdout.write('\n--- 凭据（只显示掩码）\n')
line('凭据文件', `${credentialFile} ${report.credentials.fileExists ? '(存在)' : '(不存在)'}`)
for (const [name, value] of Object.entries(report.credentials.env)) {
  if (value !== null) line(`${name} (env)`, value)
}
for (const [name, value] of Object.entries(report.credentials.inFile)) {
  if (value !== null) line(`${name} (file)`, value)
}
line('账本', `${report.credentials.ledger} ${report.credentials.ledgerExists ? '(存在)' : '(不存在)'}`)

process.stdout.write('\n--- 结论\n')
if (report.verdict.length === 0) {
  process.stdout.write('  ✓ 没发现问题。若状态行仍不对，重启 dsh-tui（/restart）后再看。\n')
} else {
  for (const item of report.verdict) process.stdout.write(`  • ${item}\n`)
}
process.stdout.write('\n')
