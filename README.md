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
dsh plugin --profile web add github:jr-create/dsh-prompt-wisp#v0.1.0

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
- 测试：`node --test`，52 项，全部离线。

### 速度设计

- 会话摘要刻意只取"大概"：最近 4 条对话、每条 160 字符、总预算 800 字符——让模型知道在聊什么即可，不拖慢请求；
- 生成封顶 4000 tokens（思考模型同样计入），并自动选用模型声明的最低推理档位（GLM 实测 `off`），典型调用 15–30 秒；
- 90 秒硬超时：按钮永远不会被一次挂起的请求卡死；思考型模型若被截断，自动重试一次不封顶的调用，宁可慢也不给空结果。

## 许可证

MIT
