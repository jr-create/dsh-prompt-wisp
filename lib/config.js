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
 * Compose the final system prompt for one call.
 *
 * `detailMode === true` → the full structured-rewrite prompt (directives B).
 * Otherwise → the COMPACT prompt: a lean instruction set tuned for the
 * 1-2s budget — same intent preservation, tighter output, no structure
 * scaffolding. The compact prompt lives here (not in engine.js) because it
 * is a config concern: it exists only to give 简便优化 its own model face.
 *
 * @param {{ trimFiller: boolean, detailMode: boolean }} [config] - the config.
 * @returns {string} the system prompt.
 */
export function composeSystemPrompt(config) {
  const resolved = normalizeConfig(config);
  if (resolved.detailMode === true) {
    const directives = buildConfigDirectives(resolved);
    // detailMode's own directive is part of B; skip it to avoid duplication.
    const trimOnly = directives.split('\n').filter((line) => line.startsWith('A.')).join('\n');
    return OPTIMIZER_PROMPT_BASE
      + (trimOnly === '' ? '' : '\n\n可选模式：\n' + trimOnly);
  }
  const lines = [
    '你是一位提示词工程师。把用户草稿改写成一段更清晰、更容易被 AI 正确理解的提示词。',
    '',
    '要求：',
    '1. 保留全部意图、约束、数据和术语；不新增目标，不删要求。',
    '2. 消除模糊表述，把指代落到具体对象上。',
    '3. 语言跟随草稿；专有名词保留。',
    '4. 只输出改写后的提示词正文——无解释、无前言、无代码围栏。',
    '5. 输出短而精：通常是 1~3 句话，长度接近原草稿；草稿已足够清晰时做轻量润色即可。',
  ];
  if (resolved.trimFiller === true) {
    lines.push(
      '6. 去废话：剔除客套话、寒暄、重复与空洞修饰（"麻烦你"、"非常感谢"、"随便"、"就行"），只留有实际内容的指令。',
    );
  }
  return lines.join('\n');
}

/* Referenced lazily to keep the directive builders above testable without
   duplicating the base prompt text. */
import { OPTIMIZER_SYSTEM_PROMPT as OPTIMIZER_PROMPT_BASE } from './engine.js';
