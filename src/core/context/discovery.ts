// Discovery globs for the chat content net's index (docs/plans/phase-2-hardening.md §3, plan
// reviews HARD-R001 and HARD-R006). `vscode.workspace.findFiles` reads globs with VS Code's glob
// engine and ripgrep, not with `isExcluded`. The index therefore searches with globs that find a
// superset of the files `isExcluded` excludes, and keeps only the files `isExcluded` excludes.
// - Each pattern is expanded as the matcher reads it: a trailing "/" means "/**", a pattern
//   without "/" is searched as "**/<pattern>", a pattern with "/" as "<pattern>" and
//   "**/<pattern>".
// - Normalisation-blind: in the NFC pattern, a non-ASCII code point becomes "*" (never crosses
//   "/"), an ASCII character that NFC or lowercasing produces from a non-ASCII code point also
//   becomes "*", and "?" becomes "*" because lowercasing can change a name's length (U+0130 →
//   "i" + U+0307). Not "?": ripgrep reads "?" as one UTF-8 byte (VS Code's watcher as one UTF-16
//   code unit), and U+212A, U+037E and U+1FEF take 2–3 bytes.
// - Case-blind on case-insensitive platforms: the other ASCII letters become "[xX]" classes.
// - VS Code and ripgrep read "**" as a globstar only when it is a whole path segment; inside a
//   segment ("a**b") it does not cross "/". The matcher's "**" always does, so such a "**" is
//   split into globs whose "**" is a whole segment ("a*b" and "a*/**/*b").
// - ripgrep drops the empty choices of a group, so a group with an empty choice is split into one
//   glob per choice (".env{,.local}" becomes ".env" and ".env.local").
// - "[", "]", a literal "{" or "}" and " " mean something else to the engines (classes, braces,
//   gitignore's trailing-space rule), so they become "?", which is safe for these one-byte
//   characters. Discovery globs are ASCII only and must be used one by one: they may contain
//   "{a,b}" groups, which do not nest.
// - "\" is an escape character to the engines. With `backslashIsSeparator: false` (POSIX) the
//   matcher reads it as part of a name, so it becomes "?" like the other engine syntax; with the
//   default, `expandPattern` has already turned it into "/" (inspection HARD-I002).

import { expandPattern, matchKey, type ExcludeOptions } from './exclude';

/** More globs than this for one pattern fall back to "**" (every file, still a superset). */
const MAX_GLOBS_PER_PATTERN = 64;

const reachable = new Map<boolean, ReadonlySet<string>>();

/**
 * Every ASCII character that occurs in `matchKey(c, options)` for a non-ASCII code point `c`,
 * computed with the running ICU (about 150 ms on the first call per mode, then cached). With
 * Node 22 it is `;` (U+037E), `` ` `` (U+1FEF) and `K` (U+212A), and case-insensitively `;`,
 * `` ` ``, `k` and `i` (U+0130).
 */
export function reachableAscii(options: ExcludeOptions = {}): ReadonlySet<string> {
  const caseInsensitive = options.caseInsensitive === true;
  let set = reachable.get(caseInsensitive);
  if (set === undefined) {
    const found = new Set<string>();
    for (let code = 0x80; code <= 0x10ffff; code++) {
      if (code >= 0xd800 && code <= 0xdfff) continue;
      for (const char of matchKey(String.fromCodePoint(code), { caseInsensitive })) {
        if (char.charCodeAt(0) < 0x80) found.add(char);
      }
    }
    set = found;
    reachable.set(caseInsensitive, set);
  }
  return set;
}

// A discovery glob as tokens: `one` is "?", `star` is "*", `any` is "**" (crosses "/") and `dirs`
// is "**/" (zero or more directories).
type Token =
  | { kind: 'text'; text: string }
  | { kind: 'one' | 'star' | 'any' | 'dirs' }
  | { kind: 'group'; choices: Token[][] };

const ONE: Token = { kind: 'one' };
const STAR: Token = { kind: 'star' };
const ANY: Token = { kind: 'any' };
const DIRS: Token = { kind: 'dirs' };
const SLASH: Token = { kind: 'text', text: '/' };
/** Literal for the matcher, syntax (or trimmed, or an escape) for VS Code and ripgrep. */
const ENGINE_SYNTAX = '[]{} \\';

interface Mapping {
  caseInsensitive: boolean;
  /** ASCII characters that a non-ASCII code point can produce in a compared form. */
  wild: ReadonlySet<string>;
  /** A pattern without "/": it is tested against the file name, where "**" is "*". */
  basename: boolean;
}

function isGlobstar(token: Token | undefined): boolean {
  return token?.kind === 'any' || token?.kind === 'dirs';
}

function isSlash(token: Token | undefined): boolean {
  return token?.kind === 'text' && token.text === '/';
}

function literal(char: string, mapping: Mapping): Token {
  if (char === '/') return SLASH;
  if (char.codePointAt(0)! >= 0x80) return STAR;
  const lower = mapping.caseInsensitive ? char.toLowerCase() : char;
  const upper = mapping.caseInsensitive ? char.toUpperCase() : char;
  // A wild character may stand for a non-ASCII character of 2–4 bytes in the raw path, and
  // ripgrep's "?" is one byte, so it becomes "*". The engine syntax characters stand for
  // themselves, one byte each, so "?" finds them.
  if ([char, lower, upper].some((form) => mapping.wild.has(form))) return STAR;
  if (ENGINE_SYNTAX.includes(char)) return ONE;
  if (lower !== upper) return { kind: 'text', text: `[${lower}${upper}]` };
  return { kind: 'text', text: char };
}

/** Tokenises an NFC pattern exactly as `globToRegExp` reads it, mapping its literals. */
function parse(glob: string, mapping: Mapping): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < glob.length) {
    const char = glob[i]!;
    const close = char === '{' ? glob.indexOf('}', i) : -1;
    if (char === '*' && glob[i + 1] === '*') {
      const dirs = glob[i + 2] === '/';
      tokens.push(mapping.basename ? STAR : dirs ? DIRS : ANY);
      i += dirs ? 3 : 2;
    } else if (char === '*' || char === '?') {
      tokens.push(STAR);
      i += 1;
    } else if (close >= 0) {
      const choices = glob.slice(i + 1, close).split(',');
      tokens.push({ kind: 'group', choices: choices.map((part) => parse(part, mapping)) });
      i = close + 1;
    } else {
      const point = String.fromCodePoint(glob.codePointAt(i)!);
      tokens.push(literal(point, mapping));
      i += point.length;
    }
  }
  return tokens;
}

/** Merges runs of wildcards into one equivalent token, so "*" and "*" never render as "**". */
function simplify(tokens: readonly Token[], whole: boolean): Token[] {
  const out: Token[] = [];
  for (const token of tokens) {
    const last = out.at(-1)?.kind;
    if (token.kind === 'group') {
      out.push({ kind: 'group', choices: token.choices.map((choice) => simplify(choice, false)) });
      continue;
    }
    if (token.kind === 'star' && (last === 'star' || last === 'any')) continue;
    if (token.kind === 'dirs' && (last === 'any' || last === 'dirs')) continue;
    if (token.kind === 'any') {
      while (out.at(-1)?.kind === 'star' || isGlobstar(out.at(-1))) out.pop();
    }
    out.push(token);
  }
  // A trailing "**/" matches only the empty string here: file paths do not end with "/".
  if (whole) while (out.at(-1)?.kind === 'dirs') out.pop();
  return out;
}

// Splits the first construct the engines would read differently from the matcher: a group with a
// "**" or an empty choice (one glob per choice; ripgrep drops empty choices, so "{,a}b" would not
// find "b"), or a "**" that is not a whole segment. `L**R` becomes `L*R` and `L*/**/*R`; `L**/R`
// becomes `LR` and `L*/**/R`. Both pairs together match exactly what the matcher's `.*` and
// `(?:.*/)?` match.
function splitOnce(tokens: readonly Token[]): Token[][] | undefined {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const before = tokens.slice(0, i);
    const after = tokens.slice(i + 1);
    const segmentStart = i === 0 || isSlash(tokens[i - 1]);
    if (
      token.kind === 'group' &&
      token.choices.some((choice) => choice.length === 0 || choice.some(isGlobstar))
    ) {
      return token.choices.map((choice) => [...before, ...choice, ...after]);
    }
    if (token.kind === 'dirs' && !segmentStart) {
      return [
        [...before, ...after],
        [...before, STAR, SLASH, DIRS, ...after],
      ];
    }
    if (token.kind === 'any' && !(segmentStart && after.length === 0)) {
      return [
        [...before, STAR, ...after],
        [...before, STAR, SLASH, DIRS, STAR, ...after],
      ];
    }
  }
  return undefined;
}

/** Globs whose every "**" is a whole segment, or undefined above the cap. */
function wholeSegmentGlobs(tokens: readonly Token[]): Token[][] | undefined {
  const done: Token[][] = [];
  const pending = [simplify(tokens, true)];
  for (let next = 0; next < pending.length; next++) {
    const split = splitOnce(pending[next]!);
    if (split === undefined) done.push(pending[next]!);
    else pending.push(...split.map((alternative) => simplify(alternative, true)));
    // Every pending glob yields at least one glob, so this bounds the final count from below.
    if (done.length + pending.length - next - 1 > MAX_GLOBS_PER_PATTERN) return undefined;
  }
  return done;
}

function render(tokens: readonly Token[]): string {
  return tokens
    .map((token) => {
      switch (token.kind) {
        case 'text':
          return token.text;
        case 'one':
          return '?';
        case 'star':
          return '*';
        case 'any':
          return '**';
        case 'dirs':
          return '**/';
        case 'group':
          return `{${token.choices.map(render).join(',')}}`;
      }
    })
    .join('');
}

/**
 * Globs for `findFiles` and the `FileSystemWatcher` that find every file `isExcluded(path,
 * patterns, options)` excludes, and usually more: callers keep only what `isExcluded` excludes.
 */
export function discoveryGlobs(
  patterns: readonly string[],
  options: ExcludeOptions = {},
): string[] {
  const caseInsensitive = options.caseInsensitive === true;
  // The matcher also compares NFC forms when case-insensitive, so both sets are wild.
  const wild = new Set(reachableAscii(options));
  if (caseInsensitive) for (const char of reachableAscii({})) wild.add(char);
  const globs = new Set<string>();
  for (const raw of patterns) {
    const pattern = expandPattern(raw, options).normalize('NFC');
    if (pattern === '') continue;
    const basename = !pattern.includes('/');
    const body = parse(pattern.replace(/^\/+/, ''), { caseInsensitive, wild, basename });
    const roots = basename ? [[DIRS, ...body]] : [body, [DIRS, ...body]];
    const variants = roots.map(wholeSegmentGlobs);
    if (variants.some((variant) => variant === undefined)) {
      globs.add('**');
      continue;
    }
    for (const variant of variants) for (const tokens of variant!) globs.add(render(tokens));
  }
  return [...globs];
}

const REGEX_SYNTAX = /[\\^$.*+?()[\]{}|]/;

// A regex model of a discovery glob as both engines read it, on code points (for tests). It
// matches only paths that both ripgrep (`findFiles`) and VS Code's glob engine (the watcher) match,
// so a path it finds is found by both:
// - "**" is a globstar only as a whole segment ("**/" is `(?:.*/)?`, a final "**" is `.*`), any
//   other "*" is `[^/]*`, "[…]" a class.
// - "?" is one ASCII character other than "/". ripgrep reads "?" as one UTF-8 byte and VS Code as
//   one UTF-16 code unit; they agree only on ASCII (U+212A is 3 bytes, but 1 code unit).
// - "{a,b}" is an alternation without its empty choices: ripgrep (globset) drops them, so
//   "{,a}b" does not match "b" there.
export function discoveryGlobToRegExp(glob: string): RegExp {
  return new RegExp(`^${engineSource([...glob])}$`, 'su');
}

function engineSource(chars: readonly string[]): string {
  let source = '';
  let i = 0;
  while (i < chars.length) {
    const char = chars[i]!;
    const bracket = char === '[' ? chars.indexOf(']', i + 1) : -1;
    const brace = char === '{' ? chars.indexOf('}', i + 1) : -1;
    if (char === '*') {
      let end = i;
      while (chars[end] === '*') end++;
      const whole =
        end - i === 2 &&
        (i === 0 || chars[i - 1] === '/') &&
        (end === chars.length || chars[end] === '/');
      if (whole && end < chars.length) {
        source += '(?:.*/)?';
        i = end + 1;
      } else {
        source += whole ? '.*' : '[^/]*';
        i = end;
      }
    } else if (char === '?') {
      source += '[\\0-.0-\\x7f]';
      i += 1;
    } else if (bracket > i + 1) {
      let body = chars.slice(i + 1, bracket);
      const negated = body[0] === '!' || body[0] === '^';
      if (negated) body = body.slice(1);
      const escaped = body.map((c) => (/[\\[\]^]/.test(c) ? `\\${c}` : c)).join('');
      source += `[${negated ? '^/' : ''}${escaped}]`;
      i = bracket + 1;
    } else if (brace >= 0) {
      const choices = chars
        .slice(i + 1, brace)
        .join('')
        .split(',')
        .filter((choice) => choice !== '');
      source += `(?:${choices.map((choice) => engineSource([...choice])).join('|')})`;
      i = brace + 1;
    } else {
      source += REGEX_SYNTAX.test(char) ? `\\${char}` : char;
      i += 1;
    }
  }
  return source;
}
