<p align="center">
  <img src="assets/dsh-tui-logo.svg" alt="dsh-TUI" width="420">
</p>

# dsh-tui-cost-meter

![Node](https://img.shields.io/badge/node-22.19%2B%20%7C%2024%2B-339933?logo=node.js&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-blue)
![dsh-tui](https://img.shields.io/badge/dsh--tui-0.16.x-5B4B8A)
![status](https://img.shields.io/badge/status-0.5.0-brightgreen)

在 dsh-tui 的底栏状态区显示**当前会话模型**对应的计费模块：

1. **Codex 剩余额度**：左边进度条，右边百分比；
2. **DeepSeek 余额 / 今日费用 / 本月消费 / 峰谷倒计时**；
3. **MiniMax Token Plan 剩余额度**：本周期 / 周额度进度条。

插件会读取 `$DSH_TUI_HOME/model.json`（默认 `~/.dsh-tui/model.json`）里 dsh-tui 每次
`/model` 切换后写入的当前 provider，**只渲染匹配的那个模块**——用 Codex 时不显示
DeepSeek / MiniMax 行，用 MiniMax 时不显示 Codex / DeepSeek 行；当前路由读取不到时
（例如文件还没生成）三个模块都照常显示，避免突然整块消失。

设置面板集成在 `/settings` 里，可直接改窗口、进度条宽度、颜色阈值、费用项和刷新间隔，实时生效。

```text
Codex 5h ███████░░░░░ 63% · 2h13m
```

```text
DeepSeek 余额 ¥60.50 · 本月 ¥130.18 · 今日 ¥4.82 ██████████
DeepSeek 平价 ━━┃────── 距峰时 1d19h
```

```text
MiniMax 5h ███████░░░ 68% · 周 76%
```

DeepSeek 第一行末尾是余额使用条：绿色剩余、橙色今日、暗色此前已用；第二行是峰谷进度条，
`┃` 是当前时刻标记。

> dsh-tui 的插件安全接缝只开放“输入框上方的状态行”（`ctx.tuiStatus`），本插件就挂在那里；
> 它不会修改 dsh-tui 自身代码，也不会写入底栏的模型/目录等宿主字段。

> **改名说明**：0.4.0 起插件名从 `dsh-tui-codex-quota` 改为 `dsh-tui-cost-meter`。
> 升级时请先卸载旧包，再安装新包；旧设置命名空间不会自动迁移。

> **0.5.0**：新增 MiniMax Token Plan 额度行，并按当前会话模型只显示对应模块。
> 升级后旧设置保留，新增的 `MiniMax 额度` 分组默认开启。

## 快速开始

### 方式一：在 dsh-tui 里用仓库链接安装（推荐）

在 dsh-tui 的输入框执行：

```text
/plugin install https://github.com/YakumoKuugen/dsh-tui-cost-meter
```

等价的简写：

```text
/plugin install github:YakumoKuugen/dsh-tui-cost-meter
```

安装器会从默认分支拉取仓库、提示第三方插件信任确认；按提示确认即可。安装完成后如果状态行没有立即出现，重启 dsh-tui 或执行 `/restart`。

> 仓库目前没有 tag/release，Git 安装会跟随 `master` 的最新提交；需要固定版本时使用下面的 tarball 方式。

### 方式二：本地 tarball 安装

```sh
npm install
npm test

npm pack --pack-destination .
dsh plugin --profile dsh-tui add "$PWD/dsh-tui-cost-meter-0.5.0.tgz"
```

然后重启 dsh-tui（或在会话里执行 `/restart`）。

> 本仓库不是已发布到 npm 的包；请按上面的 tarball 流程安装，不要直接对克隆目录执行
> `dsh plugin add .`，否则 pnpm 可能创建软链接并在运行时解析不到 `@deepseek-ai/schemastery`。
>
> 如果本机设置了 `NODE_ENV=production`，`npm install` 会跳过 devDependencies，请改用
> `npm install --include=dev` 后再跑测试。

## 目录

- [快速开始](#快速开始)
- [功能](#功能)
- [安装与卸载](#安装与卸载)
- [目录结构](#目录结构)
- [数据来源](#数据来源)
- [权限与隐私](#权限与隐私)
- [兼容性与验证](#兼容性与验证)
- [常见问题](#常见问题)
- [设置存储](#设置存储)
- [已知限制](#已知限制)
- [开发](#开发)
- [License](#license)

## 功能

- 只显示**当前会话模型**对应的计费模块（Codex / DeepSeek / MiniMax），路由未知时全部显示。
- 进度条按 **剩余额度** 填充，右侧显示整数百分比。
- 自动读取 Codex 服务端返回的滚动窗口（5 小时 / 每周 / 最短 / 最长）。
- 剩余额度低于阈值时进度条变黄 / 变红。
- 可选显示重置倒计时；点击状态行立即刷新（5 秒防抖）。
- DeepSeek 行显示：
  - 官方开放平台余额（`¥60.50`）；
  - 今日使用 DeepSeek 官方渠道的费用；
  - DeepSeek 平台后台的**本月消费金额**（登录账号时读取；失败回退到账本当月）；
  - 当前峰时/平价、距离下一次切换的倒计时；
  - 两行显示：第一行余额/本月/今日 + 余额使用条，第二行峰时/平价 + 峰谷进度条；
  - 峰谷切换时弹一次 toast，并在状态行显示 60 秒“已进入峰时/平价”提示。
- MiniMax 行显示：
  - Token Plan 的**本周期剩余百分比**（`auto` 模式按 `current_interval_*`，也可固定看周额度）；
  - `status === 3` 时识别为不限量，显示 `不限量`；
  - 进度条同样按剩余额度填充，低于阈值变黄 / 变红；
  - 国内站 `minimaxi.com` 失败时自动回退国际站 `minimax.io`。
- `/settings → 计费模块` 面板，**Codex** 分组：
  - 是否显示
  - 额度窗口（自动 / 5 小时 / 每周 / 最短 / 最长）
  - 是否显示 `Codex 5h` 标签
  - 是否显示重置倒计时
  - 不可用时是否显示占位提示
  - 进度条宽度（4–40 字符）
  - 变黄阈值、变红阈值
  - 刷新间隔（15–3600 秒）
- **DeepSeek** 分组：
  - DeepSeek 行开关、余额/今日/本月/峰谷开关
  - 余额使用条开关与宽度（4–30）
  - 峰谷切换 toast 开关
  - DeepSeek 刷新间隔（30–3600 秒）
- **MiniMax 额度** 分组：
  - 是否显示
  - 额度窗口（自动 / 本周期 / 每周）
  - 进度条宽度（4–40 字符）
  - 变黄阈值、变红阈值
  - 刷新间隔（30–3600 秒）
- 未登录、登录过期、网络失败时显示暗色占位提示，不打断输入。
- 富状态视图被宿主拒绝时自动退回纯文本状态行（同样是进度条 + 百分比）。

## 目录结构

```text
.
├── lib/                 # 插件运行时代码（不含 React / Ink 依赖）
│   ├── active-model.js   # 读取 model.json，判断当前 provider 家族
│   ├── config.js        # volatile 配置 schema
│   ├── credentials.js   # Codex OAuth 只读发现
│   ├── credential-file.js # 共享的凭据文档只读解析
│   ├── deepseek*.js     # DeepSeek 余额 / 本月消费 / 峰谷
│   ├── index.js         # Cordis apply：状态行、设置面板、轮询
│   ├── minimax*.js      # MiniMax Token Plan 客户端 / store / 视图
│   ├── quota.js         # Codex 额度纯投影
│   ├── settings.js      # /settings 字段声明
│   ├── store.js         # Codex 额度轮询
│   ├── usage-client.js  # Codex 官方额度请求
│   └── view.js          # Codex 状态行视图
├── test/                # node:test 单元测试
├── assets/              # dsh-TUI logo 与来源说明
├── cordis.patch.yml     # profile bundle 插入行
├── package.json
├── README.md
└── LICENSE
```

## 安装与卸载

### 从 GitHub 仓库直接安装

```text
/plugin install https://github.com/YakumoKuugen/dsh-tui-cost-meter
```

这是最省事的方式；需要固定版本或离线安装时，使用下面的 tarball 方式。

### 本地 tarball 安装

在本目录构建一个 tarball，然后用 dsh 的插件管理器装进 `dsh-tui` profile：

```sh
cd /path/to/dsh-tui-cost-meter
npm pack --pack-destination .

dsh plugin --profile dsh-tui add "$PWD/dsh-tui-cost-meter-0.5.0.tgz"
```

> 安装后请保留生成的 tarball：profile 的本地依赖指向它，删除后在该 profile 里重新
> `pnpm install` 会找不到本地依赖。

重启 dsh-tui 后：

1. 底栏输入框上方出现 `Codex …` 与 `DeepSeek …` 两行；
2. `/settings` 里出现 **计费模块** 面板（含 Codex / DeepSeek / MiniMax 三个分组）。

卸载：

在 dsh-tui 里：

```text
/plugin remove dsh-tui-cost-meter
```

或使用 CLI：

```sh
dsh plugin --profile dsh-tui remove dsh-tui-cost-meter
```

> 直接从一个目录 `dsh plugin add /path` 也可以用于开发，但 pnpm 可能把该目录作为软链接；
> 若你的环境解析不到 `@deepseek-ai/schemastery`，请用上面的 `npm pack` 方式安装。

## 数据来源

插件按以下顺序取额度，全部是**只读**，不会修改任何凭据文件：

1. **dsh-codex 服务**（`ctx.openAICodex`）：已登录时优先使用。它负责 OAuth 刷新和代理。
2. `$DSH_HOME/dsh-auth/credentials.json`：dsh-tui 原生 Codex 后端使用的 ChatGPT OAuth。
3. `$DSH_HOME/.openai-codex-auth.json`：dsh-codex 插件自己的凭据。
4. `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）：官方 Codex CLI 的 `tokens`。

只接受带 `accountId` 的 OAuth 令牌；`OPENAI_API_KEY` 形式的 API key 会被忽略，因为
ChatGPT 额度接口需要账号级 OAuth 会话。

DeepSeek 行是另一套只读数据源：

1. `$DSH_HOME/storages/cost-meter/ledger.json`：dsh-cost-meter 的账本。只汇总
   `deepseek` / `deepseek-official` / `deepseek-account`（含 `llm-` 前缀）的
   `byProviderModel` 桶；Codex、第三方网关、Coding Plan 不计入。
2. DeepSeek 平台本月消费接口（账号级，包含所有 API Key）：

```text
GET https://platform.deepseek.com/api/v0/usage/by_api_key/cost?start=<月初>&end=<明日零点>&tz=<时区秒>
```

账号 grant 从 `ctx.credentials.readRecord('deepseek-account-platform/default')` 读取；服务缺席时
直接读 `$DSH_HOME/.credentials.yaml` 的同名 grant。响应按日桶汇总，得到本月消费和今日消费。
接口失败时回退到 dsh-cost-meter 账本的当月合计。

3. DeepSeek 官方余额接口：

```text
GET https://api.deepseek.com/user/balance
```

余额来源按以下顺序读取，任何一步失败都会继续尝试下一步：

1. DSH 登录账号的钱包（`ctx.deepseekAccount`，与桌面版“设置→账号”同源）；
2. `DEEPSEEK_BALANCE_API_KEY`，其次 `DEEPSEEK_API_KEY`：先走 `ctx.credentials`，
   服务缺席时直接读 `$DSH_HOME/.credentials.yaml` 的 `refs` 段；
3. `llm-deepseek` 设置里的 `apiKeyEnv`。

只向官方 `api.deepseek.com` 发请求；自定义 baseURL 不会收到 Key。余额显示 `—` 表示
账号未登录且没有可用的开放平台 Key，不影响账本回退的本月/今日费用与峰谷倒计时。

请求的接口与官方 Codex 客户端相同：

```text
GET https://chatgpt.com/backend-api/wham/usage
```

若使用 HTTP(S) 代理，请确保 dsh-tui 的 Node 进程带上了代理环境变量（本机已验证
`NODE_USE_ENV_PROXY=1` + `HTTPS_PROXY` 可用）。

### MiniMax Token Plan

MiniMax 行读取的是 **Token Plan 的剩余额度**，不是账户余额或 token 用量：

```text
GET https://www.minimaxi.com/v1/token_plan/remains      # 国内站
GET https://www.minimax.io/v1/token_plan/remains        # 国际站回退
```

请求头 `Authorization: Bearer <key>`，响应里的 `model_remains[]` 提供
`current_interval_remaining_percent`（本周期剩余百分比）、`current_weekly_remaining_percent`
（周剩余百分比）与对应的 `*_status`；`status === 3` 视为不限量。注意这些数字是**剩余**比例，
和 Codex 的进度条语义一致。

API Key 按以下顺序读取，任何一步失败都会继续尝试下一步：

1. `MINIMAX_CN_API_KEY`，其次 `MINIMAX_API_KEY`：先走 `ctx.credentials`；
2. 服务缺席时直接读 `$DSH_HOME/.credentials.yaml` 的 `refs` 段；
3. 进程环境变量 `MINIMAX_CN_API_KEY` / `MINIMAX_API_KEY`。

只向上面两个官方域名发请求；两站对 Key 的归属校验不同，国内 Key 打国际站会被拒绝，
所以插件会先请求国内站、失败后再试国际站。没有任何 Key 时整行隐藏，不显示错误。

### 当前会话模型（只显示对应模块）

dsh-tui 每次 `/model` 切换都会把当前路由写进 `$DSH_TUI_HOME/model.json`
（默认 `~/.dsh-tui/model.json`，形如 `{"provider":"minimax-cn","model":"MiniMax-M3.1-Flash"}`）。
插件每 5 秒只读一次这个文件，据此决定显示哪个模块：

| provider | 显示的模块 |
| --- | --- |
| `openai-codex` | Codex 额度 |
| `deepseek` / `deepseek-official` / `deepseek-account`（含 `llm-` 前缀） | DeepSeek 费用 |
| `minimax` / `minimax-cn` | MiniMax Token Plan |
| 文件缺失 / 无法解析 | 三个模块都显示 |

插件不会写这个文件，也不依赖宿主未公开的 API；`DSH_TUI_HOME` 可覆盖默认路径（便于多 profile）。

### 登录过期 / 偶尔显示过期

访问令牌由 dsh-tui / dsh-codex 的后台流程刷新。插件看到一次 401 时**不会立刻**判定登录失效：

- 先保留上一次额度，状态行末尾显示一个暗色 `⋯`，5 秒后重新读取凭据并重试；
- 连续 3 次仍被拒绝，才显示 `登录已过期 · /login`；
- 期间只要有一次成功，就立即恢复为正常额度；
- HTTP 403 不再等同于登录过期（Cloudflare、限流、账号策略都可能返回 403），会保留旧额度并显示 `额度不可用`，等待下一次重试；
- 访问令牌自身的 `expires` 到期也不会被直接当作“登录过期”，而是让接口来判定；dsh-tui 可能正在后台刷新令牌。

如果 `登录已过期` 持续出现，在 Codex 后端执行 `/login`（或跑一次 Codex 回合让令牌刷新）。
插件不会自行刷新 OAuth，也不会把 refresh token 发到任何地方。

### DeepSeek 峰谷时刻

峰时窗口、节假日和生效时间取自 dsh-cost-meter 账本配置里的
`peakEnabled` / `peakWindows` / `peakHolidays` / `peakEffectiveAt`；没有账本时使用默认
UTC 窗口 `[1,4)`、`[6,10)`（北京时间 09:00–12:00、14:00–18:00），周末全天平价。
`周末/节假日全天平价` 从 2026-08-22 16:00 UTC 起生效。

状态行在切换后 60 秒内显示“已进入峰时/平价”，同时通过 `ctx.tuiToast` 弹一次提示。峰谷段
带一条 `━━┃────` 进度条，`┃` 是当前时刻；峰谷时钟每 5 秒走一次，不受 5 分钟余额刷新间隔
影响。若只想看倒计时、不想被弹窗打扰，关闭 `峰谷切换时弹提示` 即可。

## 权限与隐私

插件只读，不会修改任何凭据或账本文件：

- **读取的本地文件**
  - `$DSH_HOME/dsh-auth/credentials.json`：Codex OAuth
  - `$DSH_HOME/.openai-codex-auth.json`：dsh-codex 凭据
  - `$CODEX_HOME/auth.json`：官方 Codex CLI 的 `tokens`
  - `$DSH_HOME/storages/cost-meter/ledger.json`：dsh-cost-meter 账本
  - `$DSH_HOME/.credentials.yaml`：DeepSeek / MiniMax 开放平台 Key 与平台账号 grant
  - `$DSH_TUI_HOME/model.json`：当前会话 provider / model（只读，用于选择显示哪个模块）
- **访问的网络端点**
  - `https://chatgpt.com/backend-api/wham/usage`
  - `https://api.deepseek.com/user/balance`
  - `https://platform.deepseek.com/api/v0/usage/by_api_key/cost`
  - `https://www.minimaxi.com/v1/token_plan/remains`
  - `https://www.minimax.io/v1/token_plan/remains`
- **不会做的事**
  - 不写回 OAuth / API Key / 账本文件
  - 不在状态行、日志或错误信息里输出 token
  - 不把 refresh token 发到任何第三方
  - 不修改 dsh-tui 本体代码

所有设置写入都走 dsh 的 settings 服务，落在当前 profile 的配置层。

## 兼容性与验证

- 纯 ESM，无 native 依赖；Node `^22.19 || >=24`
- 插件 peer：`@deepseek-ai/schemastery >=3.18.0`
- 开发验证环境：dsh `0.2.1-rc.2`、dsh-tui `0.16.1`
- 单元测试：`node --test test/*.test.js`，当前 122 个测试
- 可选依赖：`dsh-codex`（Codex 额度服务）与 `dsh-cost-meter`（账本）
- 未安装可选依赖时，插件仍可安装并显示对应占位/回退数据

## 常见问题

**为什么在输入框上方，而不是宿主 footer？**

dsh-tui 没有把宿主 footer 的模型/目录行开放给插件；`ctx.tuiStatus` 是官方支持的底栏状态接缝，
所以状态行渲染在输入框正上方。插件不会修改 dsh-tui 本身。

**为什么只看到一行（或三行）？**

0.5.0 起按当前会话模型过滤：用 Codex 只显示 Codex 行，用 DeepSeek 只显示 DeepSeek 的两行，
用 MiniMax 只显示 MiniMax 行。如果你在 `/model` 里切换后仍看到旧模块，等 5 秒（路由轮询间隔）
或点一下状态行强制刷新。看不到 `~/.dsh-tui/model.json` 时会退回“全部显示”。

**MiniMax 行显示 68%，是用了 32% 吗？**

是。`token_plan/remains` 返回的是**剩余**百分比，进度条和百分比都按剩余额度展示，和 Codex 行一致。

**为什么 MiniMax 行不显示？**

三种可能：当前会话模型不是 MiniMax（被过滤掉了）、没有配置 `MINIMAX_CN_API_KEY` /
`MINIMAX_API_KEY`、接口请求失败。没有 Key 时整行隐藏，不会显示错误。

**为什么“本月”金额和本地账本对不上？**

本月优先读 DeepSeek 平台后台，口径是**账号级、包含所有 API Key**；dsh-cost-meter 账本通常只覆盖
本机 DSH 的调用。平台不可用时才回退到账本当月合计。

**为什么余额显示 `—`？**

账号钱包和开放平台 Key 都没有可用凭据。费用与峰谷不受影响；配置
`DEEPSEEK_BALANCE_API_KEY` 或 `DEEPSEEK_API_KEY` 后下一次刷新会恢复。

**改名后设置不见了？**

0.4.0 从 `dsh-tui-codex-quota` 改名为 `dsh-tui-cost-meter`，settings 命名空间随之变化，
旧配置不会自动迁移；在新面板里重新调整即可。

## 设置存储

`/settings` 的写入走 dsh 的 settings 服务，落在当前 profile 的配置层，命名空间是本插件
row id（默认 `dsh-tui-cost-meter`）。所有字段都是 volatile，改完立即生效，无需重启。

## 已知限制

- dsh-tui 目前没有把 Codex 后端 app-server 的 `account/rateLimits/read` 暴露给插件，所以本插件
  直接读 OAuth 凭据并请求官方额度接口；Codex 行本身不依赖当前激活的模型是不是 Codex，
  但“是否渲染”取决于当前会话 provider。
- 只显示主 `codex` 额度桶；`additional_rate_limits` 里的其他桶（例如 code review）暂不显示。
- 进度条宽度是终端字符数，窄终端会自动缩短。
- 若宿主不提供 `tuiStatus` 富视图，退回的文本行宽度固定按 80 列估算。
- DeepSeek 本月/今日优先来自平台后台；没有登录平台时回退到 dsh-cost-meter 账本。没有账本且平台不可用时，本月/今日显示 `—`。
- 余额接口需要开放平台 API Key；只提供推理账号令牌时余额会显示 `—`，不影响费用与峰谷。
- 本月消费优先读取 DeepSeek 平台后台（账号级、包含所有 API Key）；平台不可用时回退到 dsh-cost-meter 账本当月合计。账本口径不含 Codex 与第三方网关。
- 峰谷提示按账本里的窗口计算；如果手动改了 dsh-cost-meter 的峰谷配置，下一次刷新后生效。
- MiniMax 行只展示 Token Plan 的剩余百分比；不做 token 计数、不读账本、不显示金额。
  国内站被拒时会回退国际站，但国际站要求国际站 Key，两者不通用。
- 当前模型路由来自 `~/.dsh-tui/model.json`；如果宿主版本不再写这个文件，插件会退回
  “三个模块都显示”，不会报错。

## 开发

```sh
npm install
npm test
```

如果当前环境无法从 npm 拉取 `@deepseek-ai/schemastery`，也可以复用本机 dsh-tui profile 里的包：

```sh
mkdir -p node_modules/@deepseek-ai
ln -sfn "$HOME/.dsh/profiles/dsh-tui/node_modules/@deepseek-ai/schemastery" \
  node_modules/@deepseek-ai/schemastery
npm test
```

## 贡献

欢迎提 issue / PR。提交前请至少跑：

```sh
npm test
node --check lib/index.js
```

## License

MIT
