/**
 * dsh-prompt-wisp — plugin configuration (pure, host-independent).
 *
 * The optimization behavior is configurable from the plugin's own settings
 * page. Options live in one JSON document the host half stores under
 * `<DSH_HOME>/dsh-prompt-wisp/config.json` (atomic write, concurrency-safe
 * last-writer-wins), and travel to the model call as behavior directives —
 * no option ever changes what the optimizer may *not* do about correctness.
 *
 * The three options:
 *
 *  - `trimFiller`  去废话 — strip filler/politeness/redundancy from the draft.
 *  - `detailMode`  详细优化 — expand into full structured sections.
 *    `false` (default) is 简便优化: a compact, tight rewrite.
 *
 * @module dsh-prompt-wisp/config
 */

/** Settings page identity inside the DSH settings screen. */
export const SECTION_ID = 'prompt-wisp';

/**
 * The default configuration. Every field is optional in stored documents —
 * anything absent resolves to these values, so older documents stay valid.
 */
export const DEFAULT_CONFIG = Object.freeze({
  trimFiller: false,
  detailMode: false,
});

/** Valid option keys; unknown keys in a stored document are ignored. */
const KNOWN_KEYS = ['trimFiller', 'detailMode'];

/**
 * Normalize one stored or client-supplied document onto the config shape.
 *
 * Be liberal: unknown keys drop, absent keys fall back to defaults, wrong
 * types coerce to their default (a config file hand-edited to nonsense must
 * never break the button).
 *
 * @param {unknown} raw - the document to normalize.
 * @returns {{ trimFiller: boolean, detailMode: boolean }} the config.
 */
export function normalizeConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const out = { ...DEFAULT_CONFIG };
  for (const key of KNOWN_KEYS) {
    if (typeof source[key] === 'boolean') out[key] = source[key];
  }
  return out;
}

/**
 * Build the behavior directives block appended to the optimizer system
 * prompt for one call.
 *
 * Returns `''` for the default configuration — the system prompt already
 * encodes the 简便优化 baseline, and a shorter prompt is a faster call.
 *
 * @param {{ trimFiller: boolean, detailMode: boolean }} config - the config.
 * @returns {string} the directive text ('' when nothing to add).
 */
export function buildConfigDirectives(config) {
  const lines = [];
  if (config.trimFiller === true) {
    lines.push(
      'A. 去废话（开启）：先在内部剔除草稿中的客套话、寒暄、重复表述和空洞修饰（如"麻烦你"、"帮忙"、"好的"、"非常感谢"、无信息量的形容），只保留有实际内容的指令与约束；剔除后不得改变剩余内容的意思。',
    );
  }
  if (config.detailMode === true) {
    lines.push(
      'B. 详细优化（开启）：允许把改写扩展为完整的结构化提示词——背景、任务、分项要求、输出格式、边界情况都明确写出；此时长度规则放宽为最多原草稿的 3 倍。',
    );
  }
  return lines.join('\n');
}

/**
 * Compose the final system prompt for one call: the base optimizer prompt
 * plus the config directives (if any).
 *
 * @param {{ trimFiller: boolean, detailMode: boolean }} [config] - the config.
 * @returns {string} the system prompt.
 */
export function composeSystemPrompt(config) {
  const resolved = normalizeConfig(config);
  const directives = buildConfigDirectives(resolved);
  return directives === ''
    ? OPTIMIZER_PROMPT_BASE
    : OPTIMIZER_PROMPT_BASE + '\n\n可选模式：\n' + directives;
}

/* Referenced lazily to keep the directive builders above testable without
   duplicating the base prompt text. */
import { OPTIMIZER_SYSTEM_PROMPT as OPTIMIZER_PROMPT_BASE } from './engine.js';
