// Masking for the import and signature heuristics (docs/plans/phase-3-context.md C2): comments,
// the contents of string literals and (TS) of regular expressions become spaces, so brackets and
// keywords inside them count for nothing. Same length in UTF-16 code units, newlines kept, so every
// offset in the masked text is an offset in the original (inspection CTX-I001).
import type { ImportLanguage } from './imports';

/** Backward look-up bound: keeps every scan linear (security review S1). */
const LOOK_BACK = 200;

/**
 * Whether a `/` at `index` starts a regular expression literal rather than a division: the
 * previous token cannot end an expression (an operator, an opening bracket, or a keyword such as
 * `return`).
 */
function regexStarts(text: string, index: number): boolean {
  let i = index - 1;
  const stop = Math.max(0, index - LOOK_BACK);
  while (i >= stop && /\s/.test(text[i]!)) i--;
  if (i < 0) return true;
  const previous = text[i]!;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(previous)) return true;
  const word = /[A-Za-z_$][\w$]*$/.exec(text.slice(Math.max(0, i - 20), i + 1));
  return (
    word !== null &&
    /^(?:return|typeof|case|in|of|new|delete|void|throw|yield|await|else|do)$/.test(word[0])
  );
}

/** Blanks comments, string contents and (TS) regular-expression bodies; delimiters stay. */
export function maskCode(text: string, language: ImportLanguage): string {
  const out = text.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to && i < out.length; i++) if (out[i] !== '\n') out[i] = ' ';
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const lineComment = language === 'ts' ? c === '/' && text[i + 1] === '/' : c === '#';
    if (lineComment) {
      const end = text.indexOf('\n', i);
      const stop = end < 0 ? text.length : end;
      blank(i, stop);
      i = stop;
    } else if (language === 'ts' && c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end < 0 ? text.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (language === 'ts' && c === '/' && regexStarts(text, i)) {
      // A regular expression may hold quotes and unbalanced brackets: blank its body.
      // At most 500 characters, so a line of unclosed `/` costs linear work (S1).
      let j = i + 1;
      let inClass = false;
      const limit = Math.min(text.length, i + 500);
      while (j < limit && text[j] !== '\n') {
        const r = text[j]!;
        if (r === '\\') j++;
        else if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
        j++;
      }
      if (j < limit && text[j] === '/') {
        blank(i + 1, j);
        i = j + 1;
      } else {
        i++;
      }
    } else if (c === '"' || c === "'" || (language === 'ts' && c === '`')) {
      const triple = language === 'python' && text.startsWith(c.repeat(3), i);
      const close = triple ? c.repeat(3) : c;
      const start = i + close.length;
      let j = start;
      while (j < text.length && !text.startsWith(close, j)) {
        if (text[j] === '\\') j++;
        else if (!triple && c !== '`' && text[j] === '\n') break;
        j++;
      }
      blank(start, Math.min(j, text.length));
      i = Math.min(text.length, j + (text.startsWith(close, j) ? close.length : 0));
    } else {
      i++;
    }
  }
  return out.join('');
}
