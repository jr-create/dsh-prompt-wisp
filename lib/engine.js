/**
 * dsh-prompt-wisp — the optimization engine (pure, host-independent).
 *
 * Everything here is plain JavaScript with zero imports, so it can be tested
 * offline with `node --test` and imported by both the host half and tests
 * without touching a single DSH service. Anything that *needs* the host (the
 * LLM runtime, the default-model service) is passed in as a port object.
 *
 * @module dsh-prompt-wisp/engine
 */

/** Hard upper bound for an optimizable prompt, in UTF-16 code units. */
export const MAX_PROMPT_CHARS = 20000;

/**
 * The system prompt that turns any configured model into a prompt engineer.
 *
 * Kept as a template literal in one place so tests can assert its shape and
 * future iterations can tune it without hunting through call sites.
 */
export const OPTIMIZER_SYSTEM_PROMPT = [
  '你是一位资深的提示词工程师（Prompt Engineer）。',
  '用户会给你一段他们准备发给 AI 助手的提示词草稿。你的任务是把它改写成一段更清晰、更结构化、更容易被 AI 正确理解的提示词，不改写用户的本意。',
  '',
  '规则：',
  '1. 保留用户的全部意图、约束、数据和术语；不新增用户没有提出的目标，不删除任何要求。',
  '2. 补全明显的缺口：没有说清输出格式就补一个合理的格式要求；没有说清范围就补一个合理的范围界定；用一句话说明你补了什么。',
  '3. 结构化：用简短的标题或分节组织（背景 / 任务 / 要求 / 输出格式 等，按需取舍）；步骤用编号列表。',
  '4. 消除歧义：把模糊词（"尽快"、"一些"、"大概"）替换为可判定的表述。',
  '5. 语言跟随用户草稿的主要语言；专有名词保留原文。',
  '6. 只输出改写后的提示词正文本身，不要输出任何解释、前言、代码围栏或"以下是优化后的提示词"之类的话。',
  '7. 如果草稿本身已经足够清晰，做轻量润色即可，不要为改而改。',
  '8. 如果同时提供了 <context> 会话上下文：结合上下文改写——把草稿里的指代（"它"、"上面的方案"、"刚才那个"）落到上下文中的具体对象上；与前文已确定的事实、结论、约定保持一致；上下文里已明确的信息不必重复展开。上下文只是理解草稿的依据，被改写的对象始终只有草稿本身。',
].join('\n');

/**
 * The user-turn wrapper: keeps the optimizer's instruction separate from the
 * draft being optimized, so a draft that *looks like* instructions cannot
 * easily redirect the optimizer.
 */
export const OPTIMIZER_USER_WRAPPER_PREFIX = '请优化下面这段提示词草稿：\n\n<draft>\n';
export const OPTIMIZER_USER_WRAPPER_SUFFIX = '\n</draft>';

/**
 * Build the user-turn text for one optimization call.
 *
 * When a conversation digest is supplied it rides a separate `<context>`
 * section ahead of the draft: the optimizer can ground the rewrite in what
 * the session has already discussed, while the draft itself stays the only
 * thing being rewritten.
 *
 * @param {string} draft - the raw prompt draft.
 * @param {string} [digest] - optional conversation digest (see
 *   {@link buildConversationDigest}).
 * @returns {string} the wrapped user message text.
 */
export function buildOptimizerUserText(draft, digest) {
  if (typeof digest === 'string' && digest.length > 0) {
    return '先看这段会话的最近上下文：\n\n<context>\n' + digest + '\n</context>\n\n'
      + OPTIMIZER_USER_WRAPPER_PREFIX + draft + OPTIMIZER_USER_WRAPPER_SUFFIX;
  }
  return OPTIMIZER_USER_WRAPPER_PREFIX + draft + OPTIMIZER_USER_WRAPPER_SUFFIX;
}

/* ------------------------------------------------------- conversation digest */

/** How many trailing conversation messages the digest keeps at most. */
export const CONTEXT_MAX_MESSAGES = 12;
/** Per-message text cap inside the digest, in UTF-16 code units. */
export const CONTEXT_MAX_MESSAGE_CHARS = 600;
/** Whole-digest budget, in UTF-16 code units. */
export const CONTEXT_MAX_TOTAL_CHARS = 4000;
/**
 * How many trailing *events* the host-side reader fetches before digesting.
 * A generous tail: bookkeeping events dilute it, and the digest itself trims
 * to the last {@link CONTEXT_MAX_MESSAGES} conversation messages.
 */
export const CONTEXT_SCAN_EVENTS = 80;

/**
 * Extract the visible text from one message content block list.
 * @param {unknown} content - a message `content` array.
 * @returns {string} the joined text blocks, trimmed.
 */
export function messageText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block !== null && typeof block === 'object'
      && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/**
 * The type and payload of one stored event, accepting both input shapes.
 *
 * Service shape: `{ type: 'user/message', data: <payload> }`. Archive replay
 * shape: `{ type: 'event', event: { type: 'user/message', data: <payload> } }`.
 *
 * @param {unknown} event - one stored event record.
 * @returns {{ type: string, payload: object } | undefined}
 */
export function eventParts(event) {
  if (event === null || typeof event !== 'object' || typeof event.type !== 'string') return undefined;
  if (event.type === 'event' && event.event !== null && typeof event.event === 'object') {
    const inner = event.event;
    if (typeof inner.type !== 'string') return undefined;
    const payload = inner.data !== undefined ? inner.data : inner;
    return typeof payload === 'object' && payload !== null ? { type: inner.type, payload } : undefined;
  }
  const payload = event.data !== undefined ? event.data : undefined;
  return payload !== null && typeof payload === 'object' ? { type: event.type, payload } : undefined;
}

/**
 * Build a compact conversation digest from a session's event slice.
 *
 * Only genuine human prompts and model answers enter the digest:
 *
 *  - `user/message` events whose `source.kind` is `'user'` — a direct human
 *    prompt. Injected context (file-change notices, skill content, cron
 *    notifications) is also `user/message` but carries a different
 *    `source.kind` (e.g. `'plugin'`, or the runtime-context snapshots this
 *    very session shows as `source.kind === 'parent'`); treating any of them
 *    as the user's voice would poison the digest (the same distinction
 *    dsh-session-vault's title logic learned the hard way).
 *  - `assistant/message` events (their wrapped `message.content`).
 *
 * Everything else — tool calls/results, step/turn bookkeeping, system
 * messages — is noise for prompt rewriting and is skipped.
 *
 * The digest keeps the *tail* of the conversation (most recent wins), each
 * message clipped to {@link CONTEXT_MAX_MESSAGE_CHARS}, the whole digest
 * budgeted to {@link CONTEXT_MAX_TOTAL_CHARS}.
 *
 * @param {unknown} events - the event slice from `sessionPersistence`
 *   (service-shaped or archive-shaped).
 * @param {object} [options] - overrides for the three bounds.
 * @returns {{ digest: string, totalTurns: number, included: number, truncated: boolean }}
 *   `digest` is `''` when the slice holds no conversation.
 */
export function buildConversationDigest(events, options = {}) {
  const maxMessages = options.maxMessages ?? CONTEXT_MAX_MESSAGES;
  const maxCharsPerMessage = options.maxCharsPerMessage ?? CONTEXT_MAX_MESSAGE_CHARS;
  const maxTotalChars = options.maxTotalChars ?? CONTEXT_MAX_TOTAL_CHARS;

  const turns = [];
  if (Array.isArray(events)) {
    for (const event of events) {
      const parts = eventParts(event);
      if (parts === undefined) continue;
      const payload = parts.payload;
      if (parts.type === 'user/message') {
        const kind = payload.source && typeof payload.source === 'object' ? payload.source.kind : undefined;
        // `undefined` keeps working for payload-shaped inputs in tests that
        // predate the source field; every *known* non-user kind is excluded.
        if (typeof kind === 'string' && kind !== 'user') continue;
        const text = messageText(payload.content);
        if (text.length > 0) turns.push({ role: 'user', text });
      } else if (parts.type === 'assistant/message') {
        const text = messageText(payload.message && payload.message.content);
        if (text.length > 0) turns.push({ role: 'assistant', text });
      }
    }
  }

  const total = turns.length;
  if (total === 0) return { digest: '', totalTurns: 0, included: 0, truncated: false };

  const picked = turns.slice(-maxMessages);
  const lines = [];
  let used = 0;
  for (let index = picked.length - 1; index >= 0; index -= 1) {
    let text = picked[index].text;
    if (text.length > maxCharsPerMessage) text = text.slice(0, maxCharsPerMessage) + '…';
    const line = (picked[index].role === 'user' ? '用户' : '助手') + '：' + text;
    if (lines.length > 0 && used + line.length > maxTotalChars) break;
    lines.unshift(line);
    used += line.length;
  }

  const header = total > lines.length
    ? `（会话共 ${total} 条对话消息，以下为最近 ${lines.length} 条）`
    : `（会话共 ${total} 条对话消息）`;
  return {
    digest: header + '\n' + lines.join('\n'),
    totalTurns: total,
    included: lines.length,
    truncated: total > lines.length,
  };
}

/**
 * Assemble the full optimizer user text and reject drafts the engine will not
 * accept. This is the single gate both the HTTP layer and tests go through.
 *
 * @param {unknown} raw - the client-supplied draft (expected string).
 * @param {string} [digest] - optional conversation digest.
 * @returns {{ ok: true, prompt: string, userText: string }
 *   | { ok: false, error: string }}
 *   an accepted draft with its assembled user text, or a rejection reason.
 */
export function acceptPrompt(raw, digest) {
  if (typeof raw !== 'string') {
    return { ok: false, error: 'prompt 必须是字符串' };
  }
  const prompt = raw.trim();
  if (prompt.length === 0) {
    return { ok: false, error: '草稿是空的——先在输入框里写点内容再优化' };
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return {
      ok: false,
      error: `草稿太长（${prompt.length} 字符，上限 ${MAX_PROMPT_CHARS}）——请缩短后再优化`,
    };
  }
  return { ok: true, prompt, userText: buildOptimizerUserText(prompt, digest) };
}

/**
 * Resolve the model route one optimization call should use.
 *
 * Resolution order (first available wins):
 *   1. the request's explicit `{ provider, model }` — validated against the
 *      provider registry when the registry is reachable;
 *   2. the host's configured default agent model
 *      (`agentDefaultModel.currentSelection()`);
 *   3. the first registered provider's first listed model.
 *
 * @param {object} ports - host ports.
 * @param {object} [ports.llm] - the host `llm` service (LlmRuntime-like).
 * @param {object} [ports.agentDefaultModel] - the default-model service.
 * @param {{ provider?: unknown, model?: unknown }} [requested] - optional
 *   explicit route from the request body.
 * @returns {Promise<{ ok: true, provider: string, model: string, source: string }
 *   | { ok: false, error: string }>}
 *   the resolved route, or a rejection when no model is available at all.
 */
export async function resolveModelRoute(ports, requested) {
  const llm = ports && ports.llm;
  if (llm === undefined || typeof llm.stream !== 'function') {
    return { ok: false, error: '宿主没有可用的 LLM 服务（llm 服务未挂载）——无法优化提示词' };
  }

  // 1. Explicit request route, validated when the registry is reachable.
  const reqProvider = typeof requested?.provider === 'string' ? requested.provider : '';
  const reqModel = typeof requested?.model === 'string' ? requested.model : '';
  if (reqProvider !== '' && reqModel !== '') {
    let known = true;
    if (typeof llm.listProviders === 'function') {
      try {
        const providers = await llm.listProviders();
        known = Array.isArray(providers) && providers.some((p) => p && p.id === reqProvider);
      } catch {
        // An unavailable registry must not veto an explicit request; the call
        // itself will produce a precise NO_ADAPTER error if the route is wrong.
        known = true;
      }
    }
    if (known) {
      return { ok: true, provider: reqProvider, model: reqModel, source: 'request' };
    }
    return { ok: false, error: `请求的模型路由不存在：${reqProvider} / ${reqModel}` };
  }

  // 2. The host's configured default model.
  const defaults = ports && ports.agentDefaultModel;
  if (defaults && typeof defaults.currentSelection === 'function') {
    try {
      const selection = defaults.currentSelection();
      if (
        selection
        && typeof selection.provider === 'string' && selection.provider !== ''
        && typeof selection.model === 'string' && selection.model !== ''
      ) {
        return {
          ok: true,
          provider: selection.provider,
          model: selection.model,
          source: 'default',
        };
      }
    } catch {
      // Fall through to the registry fallback.
    }
  }

  // 3. First registered provider's first listed model.
  if (typeof llm.listProviders === 'function') {
    try {
      const providers = await llm.listProviders();
      const first = Array.isArray(providers) ? providers[0] : undefined;
      if (first && typeof first.id === 'string') {
        let model = '';
        if (typeof llm.listModels === 'function') {
          try {
            const models = await llm.listModels(first.id);
            if (Array.isArray(models) && models.length > 0 && typeof models[0].id === 'string') {
              model = models[0].id;
            }
          } catch {
            // Listed models may be unavailable; the provider id alone can
            // still be worth a try because adapters often have their own
            // default.
          }
        }
        if (model !== '') {
          return { ok: true, provider: first.id, model, source: 'registry' };
        }
      }
    } catch {
      // Fall through to the error below.
    }
  }

  return { ok: false, error: '没有可用的模型：宿主未配置默认模型，也没有已注册的模型路由' };
}

/**
 * Collect text deltas from one LLM chunk stream and enforce the finish reason.
 *
 * `LlmRuntime.stream()` normalizes adapter failures into terminal `finish`
 * chunks carrying `reason.kind === 'error' | 'aborted'` plus an `LlmFailure`,
 * so a caller that only reads text deltas would otherwise see a silent empty
 * answer. This collector surfaces exactly those failures as thrown errors
 * with the failure's own message.
 *
 * @param {AsyncIterable<{ type: string, text?: string, reason?: { kind: string, failure?: { message?: string, code?: string } } }>} chunks
 *   the chunk stream from `llm.stream()`.
 * @returns {Promise<string>} the concatenated text output.
 */
export async function collectText(chunks) {
  let text = '';
  for await (const chunk of chunks) {
    if (chunk === undefined || chunk === null) continue;
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
      text += chunk.text;
      continue;
    }
    if (chunk.type === 'finish') {
      const reason = chunk.reason;
      const kind = reason && reason.kind;
      if (kind === 'error' || kind === 'aborted') {
        const failure = reason.failure;
        const detail = failure && failure.message ? failure.message : '未知错误';
        const code = failure && failure.code ? `（${failure.code}）` : '';
        throw new Error(`模型调用失败${code}：${detail}`);
      }
    }
  }
  return text;
}

/**
 * Post-process one raw model answer into a clean prompt.
 *
 * Models occasionally wrap answers in a code fence or prepend a courtesy line
 * despite the system prompt forbidding it; strip the common shapes without
 * ever touching the body itself.
 *
 * @param {string} raw - the full model output.
 * @returns {string} the cleaned optimized prompt.
 */
export function cleanAnswer(raw) {
  let text = String(raw).trim();
  // One fenced block wrapping the whole answer → use its body.
  const fence = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  if (fence) text = fence[1].trim();
  // A single leading courtesy line before a markdown heading or list.
  text = text.replace(
    /^(?:好的[，,！!~\s]*|当然[，,！!~\s]*|以下是优化后的提示词[：:、\s]*)+(?=[#\-*\d`\n])/,
    '',
  ).trim();
  return text;
}

/**
 * Run one full optimization.
 *
 * @param {object} ports - host ports (`llm`, `agentDefaultModel`).
 * @param {unknown} rawPrompt - the client-supplied draft.
 * @param {{ provider?: unknown, model?: unknown }} [requested] - optional
 *   explicit model route.
 * @param {string} [digest] - optional conversation digest to ground the
 *   rewrite in the session's context.
 * @returns {Promise<{ ok: true, optimized: string, provider: string, model: string, routeSource: string, contextUsed: boolean }
 *   | { ok: false, error: string }>}
 *   the optimized prompt or a rejection reason.
 */
export async function optimizePrompt(ports, rawPrompt, requested, digest) {
  const accepted = acceptPrompt(rawPrompt, digest);
  if (!accepted.ok) return accepted;

  const route = await resolveModelRoute(ports, requested);
  if (!route.ok) return route;

  let raw;
  try {
    raw = await collectText(ports.llm.stream({
      provider: route.provider,
      model: route.model,
      system: OPTIMIZER_SYSTEM_PROMPT,
      messages: [{
        id: 'dsh-prompt-wisp-optimize-1',
        role: 'user',
        content: [{ type: 'text', text: accepted.userText }],
        source: { kind: 'user' },
      }],
    }));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  const optimized = cleanAnswer(raw);
  if (optimized.length === 0) {
    return { ok: false, error: '模型返回了空结果——请重试，或在设置里换一个模型' };
  }
  return {
    ok: true,
    optimized,
    provider: route.provider,
    model: route.model,
    routeSource: route.source,
    contextUsed: typeof digest === 'string' && digest.length > 0,
  };
}
