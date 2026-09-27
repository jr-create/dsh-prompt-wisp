# dsh-prompt-wisp · 提示词精灵

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![DSH Plugin](https://img.shields.io/badge/DeepSeek%20Harness-Plugin-4d6bfe)](https://github.com/topics/dsh-plugin)

**一句话**：在 DeepSeek Harness 聊天输入框的发送键旁加一枚 ✦ 按钮——点一下，草稿立刻被你已配置的模型改写成清晰、结构化、可直接执行的提示词。

**One-liner (EN)**: A ✦ button next to the composer's send key in DeepSeek Harness — one click rewrites your draft into a clear, structured, ready-to-run prompt using the model you already configured.

零运行时依赖 · 零外部网络请求（模型调用走宿主自己已配置的服务）· 零构建步骤

## 它做什么

| | |
| --- | --- |
| ✦ 优化按钮 | 注册在官方 `conversation.input.right` 槽位（composer 工具行、发送键左侧），深浅色主题自动适配 |
| 一键改写 | 读取输入框草稿 → 宿主端调用你配置的默认模型 → 结构化改写 → 写回输入框 |
| **会话上下文感知** | 自动读取当前会话最近的对话（经 `sessionPersistence`，最多 12 条），改写时把"它 / 上面的方案"这类指代落到具体对象上 |
| 安全围栏 | 所有 HTTP 路由 loopback-only + same-origin；草稿单次上限 20,000 字符 |
| 失败可见 | 空草稿、超长、模型错误都在按钮旁内联提示，绝不静默失败 |

改写遵循一套内置的提示词工程规则：保留全部意图与约束、补全明显缺口（输出格式/范围）、消除模糊表述、语言跟随草稿——模型只返回改写正文，不夹带解释。

### 上下文感知怎么工作

- 浏览器只把 `sessionId` 发给宿主；**会话日志只在宿主端读取**（经官方 `sessionPersistence` 服务的只读句柄，绝不碰原始 `.jsonl.zstd` 文件）；
- 摘要只取**真人发言与模型回答**——注入的上下文（文件变更通知、skill 内容等）虽也是 `user/message`，但 `source.kind === 'plugin'`，被明确排除，不会污染优化依据；
- 尾部最多 80 个事件 → 最多 12 条对话消息 → 每条截断 600 字符 → 全文预算 4000 字符；
- 上下文是**增强不是依赖**：新会话无历史、会话读取失败、persistence 服务不在，都降级为"仅按草稿优化"，按钮照样工作，成功气泡会标注「（已结合会话上下文）」。

## 安装

```bash
# 从 GitHub 安装（推荐锁定 release tag）
dsh plugin --profile web add github:jr-create/dsh-prompt-wisp#v0.2.0

# 或跟踪仓库最新状态
dsh plugin --profile web add github:jr-create/dsh-prompt-wisp

# 本地开发（链接源目录）
dsh plugin --profile web add link:<本仓库绝对路径>
```

安装后重启 `dsh web`，输入区工具行出现 ✦ 按钮即成功。

## 使用

1. 在输入框正常写草稿（中英文皆可）；
2. 点 ✦（草稿为空时按钮置灰）；
3. 等待片刻——优化结果自动替换草稿，按钮旁出现确认气泡（失败则显示红色原因）。

## 模型路由（按优先级）

1. 请求显式指定的 `{ provider, model }`（先对注册表校验）；
2. 宿主设置的默认 Agent 模型（设置页「默认模型」，`agent-default-model`）；
3. 第一个已注册 provider 的第一个模型。

`GET /api/dsh-prompt-wisp/route` 可随时查询「此刻会走哪个模型」。

## HTTP API（全部 loopback-only + same-origin 围栏）

| 端点 | 方法 | 说明 |
| --- | --- | --- |
| `/api/dsh-prompt-wisp/status` | GET | 版本、能力位（llm 服务 / 默认模型）、草稿长度上限 |
| `/api/dsh-prompt-wisp/route` | GET | 当前模型路由（不可用时返回原因而非 500） |
| `/api/dsh-prompt-wisp/optimize` | POST | `{ prompt, sessionId?, provider?, model? }` → `{ optimized, provider, model, contextUsed, contextReason?, tookMs }` |

错误约定：客户端可修复的问题（空草稿/超长/路由不存在/模型失败）返回 `200 + { ok:false, error }` 由界面内联展示；只有未预期崩溃才走 500。

## 设计与防回归（每条都有测试锁）

| 决策 | 理由 | 测试 |
| --- | --- | --- |
| 彻底零依赖 | link 安装的插件从源目录被 import，够不到宿主依赖闭包；一个宿主 import 能拖死整棵插件树 | `packaging.test.mjs` 真实 import 每个模块 + 全文禁 `@deepseek-ai` |
| 晚到服务用 `ctx.inject` | `ctx.get` 的时序缺失不报错、只静默丢功能 | 宿主半侧结构断言 |
| 槽位不碰编辑器 DOM | composer 是宿主内部的 Lexical contenteditable，DOM 私有 | `client.test.mjs` 断言无 `querySelector`/`contenteditable` |
| 模型失败必须可见 | `llm.stream` 把适配器失败归一化为终止 `finish` 分片，只读文本分片会看到静默空答案 | `collectText` 对 `error`/`aborted` 都抛出并带 `failure.message` |
| 主题变量必须成对带 fallback | 缺 token 时整条声明静默失效；品牌色在深色主题下是白色 | 逐个 `var(--dsw-*)` 检查 fallback |
| 诚实报错 | 空草稿/超长/无模型都是「可解释的失败」，不伪装成 500 | `http.test.mjs` 逐路径覆盖 |

已知边界（诚实声明）：浏览器端无 React/DOM 依赖，做不了渲染测试；`client.test.mjs` 用结构性断言守住关键生命周期。

## 权限与风险声明

- 插件读取：输入框草稿（仅在你点击 ✦ 时发送到本机宿主）、宿主默认模型配置（只读）；
- 插件写入：输入框草稿文本（仅优化结果写回）；
- 外部服务：**无**——模型调用经由宿主自身已配置的 provider，插件不直连任何外部 API；
- 不读取会话记录、不修改任何 DSH 配置。

## 兼容性

- Node `^22.19.0 || >=24.0.0`；目标 profile：**web**；
- 宿主服务均为软依赖：没有 `llm` 服务的 profile 里插件照常加载，按钮会明确提示「宿主没有可用的 LLM 服务」；没有 `sessionPersistence` 时上下文感知自动关闭，仅按草稿优化；
- 测试：`node --test`，79 项，全部离线。

## 会话执行监控

输入区上方的**全宽告警条**（官方 `conversation.input.dock` 槽位——composer 卡片正上方、正常文档流内，不遮挡输入框与会话内容）是执行监控的出口：浏览器每 5 秒轮询一次当前会话的日志尾部（宿主端经 `sessionPersistence` 只读句柄分析最近 120 个事件），检测四类执行异常：

| 检测项 | 触发条件 | 级别 |
| --- | --- | --- |
| **卡死 / 死锁** | 回合进行中，超过 45 秒没有任何新事件（工具挂起 / 模型无响应） | 🔴 alert |
| **无效输出** | 回合已执行 8+ 步，仍无任何可见文本（无意义空转） | 🟡 warn |
| **工具循环** | 同一工具以几乎相同的参数连续调用 5 次（参数按 GUID/数字/空白归一化后比较） | 🟡 warn |
| **回合失败** | 最近一个回合以错误结束（120 秒内的才提示，旧错误不算） | 🟡 warn |

告警条点击 × 关闭；关闭后若出现**新的**发现会自动重新弹出（按发现集合变化判定，旧发现不会骚扰）。标签页切到后台时轮询自动暂停。分析纯只读（`GET /api/dsh-prompt-wisp/watch`），不写入会话，不干预执行——检测到卡死时由用户决定是否中断。

### 双引擎与速度

| 模式 | 引擎 | 实测耗时 |
| --- | --- | --- |
| **简便优化**（默认） | 模型竞速 + 精简提示词（lean prompt）+ 无上下文读取，6s/路预算 | **0.5–1.5s** |
| **详细优化** | 模型竞速 + 完整结构化提示词 + 会话上下文，10s/路预算 | **1.4–4s** |

- 两种模式都向最多 3 条模型路由同时发请求，谁先给出干净答案用谁（实测常由响应最快的路由胜出）；
- 竞速失败/超时时，本地规则引擎（去废话词典 + 形状规范化 + 重复句折叠）即时兜底——宁给规则改写，不给报错；
- 会话摘要只服务详细模式，自身有 15 秒预算，超时降级为无上下文。

## 设置页

设置界面新增「提示词精灵」分区（DSH 设置 → 提示词精灵）——**本插件全部功能的集中配置**，两个分组、六个独立开关，每项标注默认值，保存后立即生效：

**分组一：提示词优化**

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| **去废话** | 关 | 剔除草稿里的客套话、寒暄、重复与空洞修饰，只留有实际内容的指令；简便与详细模式都生效 |
| **详细优化** | 关 | 开 = 完整结构化提示词 + 会话上下文（1~4s）；关 = 简便优化：精简提示词 + 模型竞速（0.5~1.5s） |

**分组二：会话执行监控**

| 开关 | 默认 | 作用 |
| --- | --- | --- |
| **显示会话监控告警条** | 开 | 在输入区上方显示执行异常告警条；关闭后完全隐藏（轮询也停止） |
| **卡死 / 死锁检测** | 开 | 回合进行中超过 45 秒无任何新事件时告警 |
| **无效输出检测** | 开 | 回合执行 8+ 步仍无可见文本时告警 |
| **工具循环检测** | 开 | 同一工具以几乎相同的参数连续调用 5 次时告警 |

配置持久化在 `<DSH_HOME>/dsh-prompt-wisp/config.json`（临时文件 + 原子重命名，手改坏的文件自动回落默认值）。

## 许可证

MIT
