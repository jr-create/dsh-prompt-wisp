/**
 * dsh-prompt-wisp — the session execution watcher (pure analysis).
 *
 * Reads a tail slice of a session's event log and answers one question:
 * *is this session healthy right now?* Four failure shapes are detected,
 * each from the event stream alone:
 *
 *  - `stalled`    死锁/卡死 — the log's last event is old (turn in flight,
 *                 no new events for STALL_MS): a hung tool call, a wedged
 *                 provider, or a crashed loop.
 *  - `no-output`  无有效输出 — a long turn (many steps) whose visible text
 *                 is still empty: the model is burning steps without saying
 *                 anything the user can read.
 *  - `tool-loop`  工具循环 — the same tool called repeatedly with near-
 *                 identical arguments (loop detected by argument-shape
 *                 equality after normalization).
 *  - `turn-err`   回合失败 — the last turn ended with an error the user may
 *                 have missed.
 *
 * Every finding carries a severity (`info` | `warn` | `alert`) and a short
 * human message. `healthy` is a finding too — the UI renders it as a green
 * tick so the user can trust the silence.
 *
 * @module dsh-prompt-wisp/watch
 */

/** No new events for this long while a turn is open → stalled. */
export const STALL_MS = 45000;
/** A turn with at least this many steps and no visible text → no-output. */
export const NO_OUTPUT_STEPS = 8;
/** The same tool called this many times with near-identical args → tool-loop. */
export const TOOL_LOOP_COUNT = 5;
/** How many trailing events the analyzer examines. */
export const WATCH_SCAN_EVENTS = 120;

/**
 * Normalize one tool-call payload into a loop-comparison shape.
 *
 * Arguments differ by timestamps, ids, and counters; the loop signal is the
 * COMMAND SHAPE. Numeric runs collapse to `N`, long opaque tokens collapse,
 * and whitespace vanishes — so `select * from a where x=1` and `...x=2`
 * compare equal while genuinely different commands stay distinct.
 *
 * @param {unknown} event - a `tool/call` event (service or archive shape).
 * @returns {{ name: string, shape: string } | undefined}
 */
export function toolCallSignature(event) {
  const payload = event && typeof event === 'object' ? (event.data ?? event.event ?? event) : undefined;
  if (payload === null || typeof payload !== 'object') return undefined;
  const name = typeof payload.name === 'string' ? payload.name : '';
  if (name === '') return undefined;
  const args = typeof payload.arguments === 'string' ? payload.arguments : '';
  const shape = args
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, 'GUID')
    .replace(/\d+/g, 'N')
    .replace(/\s+/g, ' ')
    .trim();
  return { name, shape: `${name} ${shape}`.slice(0, 400) };
}

/**
 * Extract the visible text of one message-shaped event payload.
 * @param {unknown} payload - the event's data object.
 * @returns {string} the joined text blocks.
 */
function payloadText(payload) {
  const content = payload && typeof payload === 'object'
    ? (Array.isArray(payload.content) ? payload.content : payload.message?.content)
    : undefined;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text'
      && typeof block.text === 'string')
    .map((block) => block.text)
    .join('')
    .trim();
}

/**
 * Analyze one event tail.
 *
 * @param {unknown} events - trailing events (service or archive shapes mixed).
 * @param {{ now?: number, watchStall?: boolean, watchNoOutput?: boolean,
 *   watchToolLoop?: boolean }} [options] - `now` defaults to Date.now(); the
 *   three watch switches (from the settings page) gate their rules — a
 *   switched-off rule produces no findings, the walk itself still runs.
 * @returns {{ status: 'healthy' | 'warn' | 'alert', findings: Array<{ kind: string, severity: string, message: string, sinceMs?: number }> }}
 *   the overall status (worst finding wins) and the findings list.
 */
export function analyzeWatch(events, options = {}) {
  const now = typeof options.now === 'number' ? options.now : Date.now();
  const stallEnabled = options.watchStall !== false;
  const noOutputEnabled = options.watchNoOutput !== false;
  const toolLoopEnabled = options.watchToolLoop !== false;
  const list = Array.isArray(events) ? events.filter((e) => e !== null && typeof e === 'object') : [];
  if (list.length === 0) {
    return { status: 'healthy', findings: [] };
  }

  // The turn-err rule has no dedicated switch: it is informational, never
  // actionable, and turning "show the banner" off already silences it.
  const findings = [];
  const last = list[list.length - 1];
  const lastPayload = last.data ?? last.event ?? last;
  const lastTime = typeof last.time === 'number' ? last.time : undefined;

  // ---- walk the tail once, collecting the facts each rule needs.
  let openTurn = false;
  let lastTurnStartSeq = -1;
  let lastTurnEndTime = 0;
  let lastTurnError = null;
  let stepsInOpenTurn = 0;
  let visibleCharsInOpenTurn = 0;
  const recentCalls = [];

  for (const event of list) {
    const type = typeof event.type === 'string' ? event.type : undefined;
    if (type === undefined) continue;
    const payload = event.data ?? event.event ?? event;
    const time = typeof event.time === 'number' ? event.time : 0;
    if (type === 'turn/start') {
      openTurn = true;
      lastTurnStartSeq = typeof event.seq === 'number' ? event.seq : lastTurnStartSeq;
      stepsInOpenTurn = 0;
      visibleCharsInOpenTurn = 0;
    } else if (type === 'turn/end') {
      openTurn = false;
      lastTurnEndTime = time;
      const reason = payload && typeof payload === 'object' ? payload.reason : undefined;
      if (reason && typeof reason === 'object' && reason.kind === 'error') {
        lastTurnError = reason.error && typeof reason.error === 'object' && reason.error.message
          ? String(reason.error.message)
          : '回合失败（未知错误）';
      }
    } else if (type === 'step/start') {
      stepsInOpenTurn += 1;
    } else if (type === 'assistant/message') {
      visibleCharsInOpenTurn += payloadText(payload).length;
    } else if (type === 'tool/call') {
      const signature = toolCallSignature(event);
      if (signature) recentCalls.push(signature);
    }
  }

  // ---- rule 1: stalled (deadlock / hung tool / wedged provider).
  if (stallEnabled && openTurn && lastTime !== undefined) {
    const sinceMs = Math.max(0, now - lastTime);
    if (sinceMs >= STALL_MS) {
      findings.push({
        kind: 'stalled',
        severity: 'alert',
        message: `回合已 ${Math.round(sinceMs / 1000)} 秒没有任何新事件——工具可能卡死或模型无响应。可中断后重试。`,
        sinceMs,
      });
    }
  }

  // ---- rule 2: no-output (long turn, nothing readable).
  if (noOutputEnabled && openTurn && stepsInOpenTurn >= NO_OUTPUT_STEPS && visibleCharsInOpenTurn === 0) {
    findings.push({
      kind: 'no-output',
      severity: 'warn',
      message: `本回合已执行 ${stepsInOpenTurn} 步，还没有任何可见文本输出——可能在无意义地循环调用工具。`,
    });
  }

  // ---- rule 3: tool-loop (same tool, near-identical arguments).
  if (toolLoopEnabled && recentCalls.length >= TOOL_LOOP_COUNT) {
    const window = recentCalls.slice(-TOOL_LOOP_COUNT);
    const allSame = window.every((signature) => signature.shape === window[0].shape);
    if (allSame) {
      findings.push({
        kind: 'tool-loop',
        severity: 'warn',
        message: `工具 "${window[0].name}" 已用几乎相同的参数连续调用 ${TOOL_LOOP_COUNT} 次——疑似陷入循环。`,
      });
    }
  }

  // ---- rule 4: turn-error (the most recent finished turn failed).
  if (!openTurn && lastTurnError !== null && lastTurnEndTime > 0) {
    const sinceMs = Math.max(0, now - lastTurnEndTime);
    // Only surface a fresh failure; an old one is history, not a finding.
    if (sinceMs <= STALL_MS * 2) {
      findings.push({
        kind: 'turn-err',
        severity: 'warn',
        message: `最近一个回合以错误结束：${lastTurnError}`,
        sinceMs,
      });
    }
  }

  // ---- rule 5 (positive signal): a completed turn right before an open one,
  // or simply quiet-but-closed, renders as healthy.
  if (findings.length === 0) {
    return { status: 'healthy', findings: [] };
  }
  const rank = { info: 0, warn: 1, alert: 2 };
  const status = findings.reduce((worst, finding) => (rank[finding.severity] > rank[worst] ? finding.severity : worst), 'info');
  return { status, findings };
}
