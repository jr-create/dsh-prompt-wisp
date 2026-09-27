/**
 * dsh-prompt-wisp — the local (no-model) compact optimizer.
 *
 * 简便优化 must land in 1-2 seconds; a remote model call cannot. This module
 * does the compact rewrite with pure text rules instead — filler trimming
 * (the 去废话 dictionary), whitespace/punctuation normalization, and adjacent
 * duplicate-sentence removal — in well under a millisecond, with zero model
 * calls and zero token cost.
 *
 * The rules are deliberately conservative: they REMOVE noise and NORMALIZE
 * shape, they never invent requirements the way the model path may. Meaning
 * preservation is the invariant; when in doubt a rule does not fire.
 *
 * @module dsh-prompt-wisp/local
 */

/** Interjections allowed at the very start of a draft ("好的，" "嗯，" "哈喽"). */
const LEADING_INTERJECTION =
  /^(?:好的+|好滴|好嘞|好的呢|嗯+|哦+|噢+|哈喽|你好|您好|嗨+|hi+|hello|hey)\s*[，,！!。.~～]?/i;

/** Politeness/filler tokens stripped from the tail, repeatedly. */
const TRAILING_SOFTENER_TOKENS =
  '麻烦你了|麻烦您了|非常感谢|太感谢了|多谢了|多谢|谢谢你了|谢谢啦|谢谢|辛苦你了|辛苦了|拜托了|拜托|感谢|thanks a lot|thanks|thank you';

/** Tail softeners ("就行", "就好了") that carry no requirement. */
const TAIL_SOFTENER = /(?:就行了|就好啦|就可以了|就行啦|就好了|就行|便了)\s*$/;

/** Mid-sentence filler replacements; longer (more specific) patterns first. */
const MID_REPLACEMENTS = [
  // Word-shaped politeness first, so a tail regex cannot strand a particle
  // ("麻烦你了" must go whole — trimming "麻烦你" leaves a dangling 了).
  [/麻烦你了|麻烦您了|麻烦你啦|麻烦您啦/g, ''],
  [/麻烦你帮我/g, '帮我'],
  [/麻烦您帮我/g, '帮我'],
  [/麻烦你/g, ''],
  [/麻烦您/g, ''],
  [/劳驾/g, ''],
  [/我就是想让你帮我/g, '帮我'],
  [/我就是想让你/g, ''],
  [/我想让你帮我/g, '帮我'],
  [/我想让你/g, ''],
  [/我希望你能够/g, '请你'],
  [/我希望你能/g, '请你'],
  [/我希望你/g, '请你'],
  [/请你帮我/g, '帮我'],
  // "随便写个…" / "大概几句话" — vague quality/quantity words the requirement
  // itself does not need (the quantity stays; only the hedge goes).
  [/随便(?=[写说讲弄搞做给])/g, ''],
  [/大概(?=[一二两三四五六七八九十\d]+\s*(?:句话|段话|行|个要点|条))/g, ''],
];

/** Strip stacked leading interjections ("好的，嗯，帮我…" → "帮我…"). */
function stripLeadingInterjections(text) {
  for (let i = 0; i < 5; i += 1) {
    const next = text.replace(LEADING_INTERJECTION, '').trimStart();
    if (next === text) break;
    text = next;
  }
  return text;
}

/** Strip stacked trailing gratitude ("…，谢谢，麻烦你了" → "…"). */
function stripTrailingSofteners(text) {
  const re = new RegExp('[\\s，,；;。]*?(?:' + TRAILING_SOFTENER_TOKENS + ')[!！。.~～\\s]*$', 'i');
  for (let i = 0; i < 5; i += 1) {
    const next = text.replace(re, '').trimEnd();
    if (next === text) break;
    text = next;
  }
  return text;
}

/** Strip stacked tail softeners and the punctuation they leave behind. */
function stripTailSofteners(text) {
  for (let i = 0; i < 4; i += 1) {
    const next = text
      .replace(TAIL_SOFTENER, '')
      .trimEnd()
      .replace(/[，,；;。]$/, '')
      .trimEnd();
    if (next === text) break;
    text = next;
  }
  return text;
}

/**
 * Run the local compact optimization on one draft.
 *
 * @param {unknown} rawDraft - the draft (expected string).
 * @param {{ trimFiller?: boolean }} [options] - the 去废话 switch.
 * @returns {{ optimized: string, changed: boolean }} the cleaned draft and
 *   whether anything actually changed (`optimized` is the original when the
 *   rules had nothing to do — never an empty string).
 */
export function optimizeLocally(rawDraft, options = {}) {
  const trimFiller = options.trimFiller === true;
  const original = String(rawDraft ?? '').replace(/\r\n?/g, '\n').trim();
  let text = original;
  if (text.length === 0) return { optimized: original, changed: false };

  if (trimFiller) {
    text = stripLeadingInterjections(text);
    for (const [pattern, replacement] of MID_REPLACEMENTS) {
      text = text.replace(pattern, replacement);
    }
    text = stripTrailingSofteners(text);
    text = stripTailSofteners(text);
    text = text.replace(/^[，,。；;！!\s]+/, '');
  }

  // Shape normalization (always, regardless of 去废话).
  text = text
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/([!！]){2,}/g, '$1')
    .replace(/([？?]){2,}/g, '$1')
    .replace(/([~～]){2,}/g, '$1')
    .replace(/。{2,}/g, '。')
    .trim();

  // Collapse adjacent duplicate sentences ("帮我写总结。帮我写总结。" → one).
  // The split keeps line structure: each LINE dedupes internally, and lines
  // rejoin with their newlines — a multi-line draft must not be flattened.
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const sentences = lines[index].match(/[^。！？!?…]+[。！？!?…]?/g);
    if (!sentences) continue;
    const kept = [];
    for (const sentence of sentences) {
      const key = sentence.trim();
      if (key.length === 0) continue;
      if (kept.length > 0 && kept[kept.length - 1] === key) continue;
      kept.push(key);
    }
    if (kept.length > 0) lines[index] = kept.join('');
  }
  text = lines.join('\n');

  text = text.trim();
  if (text.length === 0) return { optimized: original, changed: false };
  if (!/[。！？!?…~～:：]$/.test(text)) text += '。';

  const changed = text !== original;
  return { optimized: changed ? text : original, changed };
}
