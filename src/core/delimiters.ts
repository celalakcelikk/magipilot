// Bracket ownership for post-processing (inspections P1-I008, P1-I013, P1-I014). A small lexer
// walks the context before the cursor and then the completion, keeping a typed stack of open
// brackets and who opened them. Strings, comments and (in JavaScript/TypeScript) regex literals
// are skipped. Anything it cannot place — a closer of the wrong type, a closer with nothing open —
// marks the result as uncertain, and callers then cut nothing.

export type Owner = 'context' | 'completion';

export interface CloserEvent {
  /** Offset in the text passed to feed(). */
  index: number;
  closes: Owner;
  /** Offset of the matching opener in the text it was fed with (prefix or completion). */
  openerIndex: number;
}

const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);

/** Languages whose blocks are defined by indentation, not brackets. */
export const INDENTATION_LANGUAGES: ReadonlySet<string> = new Set([
  'python',
  'yaml',
  'coffeescript',
  'fsharp',
  'nim',
  'haskell',
  'elm',
  'pug',
  'sass',
  'stylus',
]);

const HASH_COMMENT = new Set([
  'python',
  'ruby',
  'shellscript',
  'yaml',
  'perl',
  'r',
  'makefile',
  'dockerfile',
  'toml',
  'coffeescript',
  'elixir',
  'julia',
  'powershell',
  'nim',
]);
/** Languages where `'` starts a short character literal (or a Rust lifetime), not a string. */
const CHAR_QUOTE = new Set([
  'rust',
  'c',
  'cpp',
  'java',
  'csharp',
  'go',
  'kotlin',
  'scala',
  'swift',
]);
const REGEX_LANGUAGES = new Set(['javascript', 'typescript', 'javascriptreact', 'typescriptreact']);
/** After one of these, `/` starts a regex literal rather than a division. */
const REGEX_PRECEDERS = new Set([...'(,=:[!&|?{};+-*%<>~^'.split(''), '']);

interface Open {
  closer: string;
  owner: Owner;
  index: number;
}

export class DelimiterScanner {
  readonly stack: Open[] = [];
  uncertain = false;
  /** Brackets seen outside strings and comments. */
  opened = 0;
  closed = 0;
  private quote?: string;
  private blockComment = false;
  private lineComment = false;
  private regex = false;
  private regexClass = false;
  private lastSignificant = '';
  /**
   * A token cut by the end of the previous feed() — the prefix ends where the cursor is, so a
   * backslash or a block-comment `*` can be completed by the completion's first character (C8).
   */
  private carry?: 'escape' | 'star';

  constructor(private readonly languageId = 'typescript') {}

  /** Inside a string, comment or regex literal right now. */
  get inLiteral(): boolean {
    return this.quote !== undefined || this.blockComment || this.lineComment || this.regex;
  }

  get hashComments(): boolean {
    return HASH_COMMENT.has(this.languageId);
  }

  /** Feeds text owned by `owner` and reports every closer outside strings and comments. */
  feed(text: string, owner: Owner): CloserEvent[] {
    const events: CloserEvent[] = [];
    const python = this.languageId === 'python';
    let start = 0;
    if (this.carry === 'escape' && (this.quote !== undefined || this.regex)) {
      start = 1; // the first character is escaped
    } else if (this.carry === 'star' && this.blockComment && text.startsWith('/')) {
      this.blockComment = false;
      start = 1;
    }
    this.carry = undefined;
    for (let i = start; i < text.length; i++) {
      const char = text[i]!;
      const next = text[i + 1];
      if (this.lineComment) {
        if (char === '\n') this.lineComment = false;
        continue;
      }
      if (this.blockComment) {
        if (char === '*' && next === '/') {
          this.blockComment = false;
          i++;
        } else if (char === '*' && next === undefined) this.carry = 'star';
        continue;
      }
      if (this.regex) {
        if (char === '\\') {
          if (next === undefined) this.carry = 'escape';
          i++;
        } else if (char === '[') this.regexClass = true;
        else if (char === ']') this.regexClass = false;
        else if (char === '/' && !this.regexClass) this.regex = false;
        else if (char === '\n') {
          this.regex = false; // it was a division after all
          this.uncertain = true;
        }
        continue;
      }
      if (this.quote) {
        if (char === '\\') {
          if (next === undefined) this.carry = 'escape';
          i++;
        } else if (this.quote.length === 3 && text.startsWith(this.quote, i)) {
          this.quote = undefined;
          i += 2;
        } else if (this.quote.length === 1 && char === this.quote) this.quote = undefined;
        else if (char === '\n' && this.quote !== '`' && this.quote.length === 1) {
          this.quote = undefined; // unterminated single-line string
          this.uncertain = true;
        }
        continue;
      }
      if (char === '/' && next === '/' && !this.hashComments) {
        this.lineComment = true;
        continue;
      }
      if (char === '#' && this.hashComments) {
        this.lineComment = true;
        continue;
      }
      if (char === '/' && next === '*' && !python) {
        this.blockComment = true;
        i++;
        continue;
      }
      if (
        char === '/' &&
        REGEX_LANGUAGES.has(this.languageId) &&
        REGEX_PRECEDERS.has(this.lastSignificant)
      ) {
        this.regex = true;
        this.regexClass = false;
        continue;
      }
      if (python && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
        this.quote = text.slice(i, i + 3);
        i += 2;
        continue;
      }
      if (char === "'" && CHAR_QUOTE.has(this.languageId)) {
        const literal = /^'(?:\\.[^'\n]{0,8}|[^\\'\n])'/.exec(text.slice(i));
        if (literal) i += literal[0].length - 1; // a char literal; otherwise a lifetime
        this.lastSignificant = "'";
        continue;
      }
      if (char === '"' || char === "'" || char === '`') {
        this.quote = char;
        continue;
      }
      if (char in OPENERS) {
        this.opened++;
        this.stack.push({ closer: OPENERS[char]!, owner, index: i });
      } else if (CLOSERS.has(char)) {
        this.closed++;
        const top = this.stack.at(-1);
        if (!top || top.closer !== char) {
          this.uncertain = true;
          if (top) this.stack.pop();
        } else {
          this.stack.pop();
          events.push({
            index: i,
            closes: top.owner,
            openerIndex: top.index,
          });
        }
      }
      if (!/\s/.test(char)) this.lastSignificant = char;
    }
    return events;
  }
}

export interface Ownership {
  closers: CloserEvent[];
  /** True when the scan met something it could not place; callers must not cut closers. */
  uncertain: boolean;
  /** Brackets the completion opened and did not close. */
  openedByCompletion: number;
  /** The innermost bracket open at the cursor (what the suffix's first closer would close). */
  contextTop?: { closer: string; index: number };
  /** The completion ends inside a string, comment or regex literal. */
  endsInLiteral: boolean;
}

/** Ownership of every closer in `completion`, given the text before the cursor. */
export function ownership(prefix: string, completion: string, languageId?: string): Ownership {
  const scanner = new DelimiterScanner(languageId);
  scanner.feed(prefix, 'context');
  // A context that does not parse cleanly (e.g. a prefix cut inside a construct) is not trusted.
  const contextUncertain = scanner.uncertain;
  const top = scanner.stack.at(-1);
  const closers = scanner.feed(completion, 'completion');
  return {
    closers,
    uncertain: contextUncertain || scanner.uncertain,
    openedByCompletion: scanner.stack.filter((open) => open.owner === 'completion').length,
    contextTop: top ? { closer: top.closer, index: top.index } : undefined,
    endsInLiteral: scanner.inLiteral,
  };
}

export interface LineState {
  /** The line starts inside a string, comment or regex literal. */
  inLiteral: boolean;
  /** Brackets the completion opened before this line and has not closed yet. */
  openByCompletion: number;
  /** All brackets open at the start of this line, the context's included (C-I001). */
  openTotal: number;
}

/** Lexical state at the start of each completion line (P1-I019). */
export function lineStates(
  prefix: string,
  lines: readonly string[],
  languageId?: string,
): { states: LineState[]; uncertain: boolean } {
  const scanner = new DelimiterScanner(languageId);
  scanner.feed(prefix, 'context');
  const states: LineState[] = [];
  lines.forEach((line, i) => {
    states.push({
      inLiteral: scanner.inLiteral,
      openByCompletion: scanner.stack.filter((open) => open.owner === 'completion').length,
      openTotal: scanner.stack.length,
    });
    scanner.feed(i < lines.length - 1 ? `${line}\n` : line, 'completion');
  });
  return { states, uncertain: scanner.uncertain };
}

/** Opening minus closing brackets of a whole text, outside strings and comments (tests). */
export function delimiterBalance(text: string, languageId?: string): number {
  const scanner = new DelimiterScanner(languageId);
  scanner.feed(text, 'context');
  return scanner.opened - scanner.closed;
}
