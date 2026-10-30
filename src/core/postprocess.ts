// Turns a raw model answer into the text to insert at the cursor (PLAN §6.6).
// Steps, in order: line endings → fenced block → explanation lines → echoed cursor marker →
// repeated prefix → first-line indentation (the Faz 0 haiku habit) → block end → suffix overlap →
// max lines → empty check. Returns null when nothing useful is left.
// Principle (inspection round 3): cut only what is provably redundant; when unsure, keep it.
import { lineBeforeCursor } from './context/cursor';
import { INDENTATION_LANGUAGES, lineStates, ownership } from './delimiters';
import { CURSOR } from './prompt/templates';

export interface PostprocessContext {
  prefix: string;
  suffix: string;
  maxLines: number;
  /** VS Code language id; decides how a block ends. Unknown → bracket rules. */
  languageId?: string;
  /**
   * `fim` models return the exact middle: they never echo the prefix and their leading
   * indentation is meant (inspection C-I003). `chat` (default) models (the CLIs) may do both.
   */
  backendKind?: 'fim' | 'chat';
}

// Fences count only as standalone lines (inspection P1-I007): backticks inside code are kept.
const FENCE_OPEN = /^\s*```[\w.+#-]*\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;
/** "Here you go:" — a sentence ending in a colon, without code characters. */
const INTRO_LINE = /^[A-Z][^(){}[\]=;"'`]*:$/;
const LEADING_PROSE =
  /^(?:here(?:'s| is| are)\b|sure\b|certainly\b|of course\b|the (?:missing|completion|completed|code)\b|completion:|output:)/i;
const TRAILING_PROSE =
  /^(?:note|this|these|explanation|the above|i (?:have|added|used))(?=[\s:,]|$)/i;
/** Characters that make a line code rather than an explanation (inspection P1-I009). */
const CODE_CHARS = /[(){}[\];=<>`]/;
/** Overlap that may be cut from the end of the cursor line: closers and punctuation only. */
const CLOSING_PUNCTUATION = /^[\s)\]};,]+$/;

function isProse(line: string, pattern: RegExp): boolean {
  const trimmed = line.trim();
  return pattern.test(trimmed) && !CODE_CHARS.test(trimmed.replace(/:$/, ''));
}

const STARTS_WITH_CLOSER = /^\s*[)\]}]/;

/**
 * Whether `full.slice(cutAt)` may be cut off: every bracket closer in it must close a bracket
 * opened before the cursor or inside the cut part itself — never one the kept completion opened
 * (P1-I008, P1-I014) — and the bracket scan must be certain.
 */
function mayCut(ctx: PostprocessContext, full: string, cutAt: number): boolean {
  if (!/[)\]}]/.test(full.slice(cutAt))) return true;
  const own = ownership(ctx.prefix, full, ctx.languageId);
  if (own.uncertain) return false;
  return own.closers
    .filter((c) => c.index >= cutAt)
    .every((c) => c.closes === 'context' || (c.openerIndex ?? -1) >= cutAt);
}

/** Offset of each line's first non-blank character in `lines.join('\n')`. */
function lineStarts(lines: string[]): number[] {
  const starts: number[] = [];
  let offset = 0;
  for (const line of lines) {
    starts.push(offset + (/^\s*/.exec(line)?.[0].length ?? 0));
    offset += line.length + 1;
  }
  return starts;
}

function indentOf(line: string): number {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].replace(/\t/g, '    ').length : 0;
}

function isIntro(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === '' || LEADING_PROSE.test(trimmed) || INTRO_LINE.test(trimmed);
}

/**
 * Unwraps a fenced answer. The opening fence must start the answer (after explanation lines at
 * most); a fence line that follows code belongs to the code, e.g. a Markdown template string.
 * Everything after the closing fence is explanation and dropped.
 */
function stripFence(text: string): string {
  const lines = text.split('\n');
  const open = lines.findIndex((line) => FENCE_OPEN.test(line));
  if (open < 0 || !lines.slice(0, open).every(isIntro)) return text;
  const close = lines.findIndex((line, i) => i > open && FENCE_CLOSE.test(line));
  return lines.slice(open + 1, close < 0 ? undefined : close).join('\n');
}

function stripProse(lines: string[]): string[] {
  let result = lines;
  // Leading "Here is the completion:" style lines (only when code follows).
  while (result.length > 1 && isProse(result[0]!, LEADING_PROSE)) {
    result = result.slice(1);
  }
  // Trailing explanation paragraph after a blank line.
  const lastBlank = result.findLastIndex((line) => line.trim() === '');
  if (lastBlank > 0) {
    const tail = result.slice(lastBlank + 1).filter((line) => line.trim() !== '');
    if (tail.length > 0 && tail.every((line) => isProse(line, TRAILING_PROSE))) {
      result = result.slice(0, lastBlank);
    }
  }
  return result;
}

/**
 * A chat model sometimes repeats the text already on the cursor line. Only a repeat that contains
 * a word character counts: punctuation alone ("/" before "/ TODO") is ambiguous (C-I003).
 */
function stripRepeatedPrefix(text: string, prefix: string): string {
  const currentLine = lineBeforeCursor(prefix);
  const typed = currentLine.trim();
  if (typed === '' || !/\w/.test(typed)) return text;
  const trimmed = text.trimStart();
  if (trimmed.startsWith(currentLine.trimStart())) {
    return trimmed.slice(currentLine.trimStart().length);
  }
  return text;
}

/**
 * For FIM output (C-I004): is the cursor already indented at least as deep as the line it is
 * on needs to be? Then extra leading whitespace from the model is over-indentation (the small
 * Qwen model's habit). If the line above opens a block and the cursor is not deeper than that
 * line, the model's indentation is needed and is kept.
 */
function cursorAtBodyLevel(prefix: string): boolean {
  const lines = prefix.split('\n');
  const current = lines.at(-1) ?? '';
  if (current === '' || current.trim() !== '') return false;
  const previous = lines
    .slice(0, -1)
    .reverse()
    .find((line) => line.trim() !== '');
  if (previous === undefined) return true;
  const opensBlock = /(?:[{([:]|=>)\s*$/.test(previous);
  return opensBlock
    ? indentOf(current) > indentOf(previous)
    : indentOf(current) >= indentOf(previous);
}

/**
 * The cursor already sits after the indentation: drop the model's own leading indent/newlines
 * (the Faz 0 haiku habit). For FIM output only when the cursor is at body level (C-I004).
 */
function alignFirstLine(text: string, prefix: string): string {
  const currentLine = lineBeforeCursor(prefix);
  if (currentLine.trim() !== '') return text;
  return text.replace(/^(?:[ \t]*\n)*[ \t]*/, '');
}

/**
 * Stops where the completion leaves the cursor's block.
 * - Indentation languages (Python, YAML, …): before the first *structural* line indented below
 *   the cursor line — one that starts outside strings/comments and outside brackets the
 *   completion opened (P1-I019).
 * - Everything else (P1-I013): indentation is not structure. Stop only before a later line that
 *   starts with a closer of exactly the bracket the suffix closes first — the innermost bracket
 *   open at the cursor, same type (P1-I018) — because the completion is about to duplicate it.
 * An uncertain scan cuts nothing.
 */
function stopAtBlockEnd(lines: string[], ctx: PostprocessContext): string[] {
  if (INDENTATION_LANGUAGES.has(ctx.languageId ?? '')) {
    const base = indentOf(lineBeforeCursor(ctx.prefix));
    if (base === 0) return lines;
    const { states, uncertain } = lineStates(ctx.prefix, lines, ctx.languageId);
    if (uncertain) return lines;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.trim() === '' || indentOf(line) >= base) continue;
      // Inside any bracket — the context's too — Python joins lines implicitly: indentation is
      // not structure there (C-I001).
      const state = states[i]!;
      if (state.inLiteral || state.openTotal > 0) continue;
      return lines.slice(0, i);
    }
    return lines;
  }

  const own = ownership(ctx.prefix, lines.join('\n'), ctx.languageId);
  const suffixCloser = /^\s*([)\]}])/.exec(ctx.suffix)?.[1];
  const target = own.contextTop;
  if (!suffixCloser || own.uncertain || !target || target.closer !== suffixCloser) return lines;
  const starts = lineStarts(lines);
  for (let i = 1; i < lines.length; i++) {
    if (!STARTS_WITH_CLOSER.test(lines[i]!)) continue;
    const event = own.closers.find((c) => c.index === starts[i]);
    if (event?.closes === 'context' && event.openerIndex === target.index) return lines.slice(0, i);
  }
  return lines;
}

/**
 * Removes trailing lines / text the suffix already contains. A completion that only repeats what
 * follows the cursor is removed entirely, so no duplicate is offered (inspection P1-I006).
 */
function trimSuffixOverlap(lines: string[], ctx: PostprocessContext): string[] {
  const suffixLines = ctx.suffix.split('\n');
  const sameLine = suffixLines[0] ?? '';
  let result = [...lines];

  // Whole lines repeated from the start of the suffix (ignoring indentation and blank lines).
  // The first completion line continues the cursor line, so it is compared together with it.
  const suffixHead = suffixLines
    .slice(1)
    .filter((line) => line.trim() !== '')
    .map((line) => line.trim());
  const candidates = sameLine.trim() === '' ? suffixHead : [];
  const asLines = result.map((line, i) => (i === 0 ? lineBeforeCursor(ctx.prefix) + line : line));
  for (let k = Math.min(candidates.length, result.length); k > 0; k--) {
    const tail = asLines.slice(asLines.length - k).map((line) => line.trim());
    if (!tail.every((line, i) => line === candidates[i])) continue;
    const kept = result.slice(0, result.length - k);
    const cutAt = kept.length === 0 ? 0 : kept.join('\n').length + 1;
    if (mayCut(ctx, result.join('\n'), cutAt)) {
      result = kept;
      break;
    }
  }

  // Text on the cursor line that the suffix already provides: the whole rest of the line, or
  // closers / punctuation at its start, e.g. the model's ")" before an existing ");" (P1-I010).
  const tailText = sameLine.trimEnd();
  if (tailText.trim() !== '' && result.length > 0) {
    const last = result[result.length - 1]!.trimEnd();
    const before = result.slice(0, -1);
    const lastStart = before.length === 0 ? 0 : before.join('\n').length + 1;
    for (let size = Math.min(last.length, tailText.length); size > 0; size--) {
      const overlap = tailText.slice(0, size);
      if (!last.endsWith(overlap)) continue;
      if (overlap !== tailText && !CLOSING_PUNCTUATION.test(overlap)) continue;
      const full = [...before, last].join('\n');
      if (!mayCut(ctx, full, lastStart + last.length - size)) continue;
      result = [...before, last.slice(0, last.length - size)];
      break;
    }
  }
  return result;
}

export function postprocess(raw: string, ctx: PostprocessContext): string | null {
  let text = raw.replace(/\r\n/g, '\n');
  // Presentation clean-up only where the text cannot be content: inside a string or comment at
  // the cursor, fences, prose-like lines, marker text and leading spaces all belong to the
  // literal (C-I002, C-I005). A FIM model never echoes the prefix and its leading whitespace is
  // exact (C-I003, C-I004); the haiku-habit indent fix applies to chat models only.
  const kind = ctx.backendKind ?? 'chat';
  if (!ownership(ctx.prefix, '', ctx.languageId).endsInLiteral) {
    text = stripFence(text);
    text = stripProse(text.split('\n')).join('\n');
    text = text.split(CURSOR).join('');
    if (kind === 'chat') {
      text = stripRepeatedPrefix(text, ctx.prefix);
      text = alignFirstLine(text, ctx.prefix);
    } else if (cursorAtBodyLevel(ctx.prefix)) {
      text = alignFirstLine(text, ctx.prefix);
    }
  }

  // Whitespace inside lines is kept: it may belong to a string literal (P1-I015).
  let lines = text.split('\n');
  lines = stopAtBlockEnd(lines, ctx);
  lines = trimSuffixOverlap(lines, ctx);
  // Trailing blank lines and spaces are formatting — unless the completion ends inside a string
  // (or comment) that the suffix continues (P1-I020).
  const endsInLiteral = (ls: string[]): boolean =>
    ownership(ctx.prefix, ls.join('\n'), ctx.languageId).endsInLiteral;
  if (!endsInLiteral(lines)) {
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
  }
  lines = lines.slice(0, Math.max(1, ctx.maxLines));
  if (lines.length > 0 && !endsInLiteral(lines)) {
    lines[lines.length - 1] = lines[lines.length - 1]!.trimEnd();
  }

  const result = lines.join('\n');
  return result.trim() === '' ? null : result;
}
