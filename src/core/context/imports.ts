// Local imports of a document and the files they may name (docs/plans/phase-3-context.md C1):
// TypeScript/JavaScript relative specifiers and Python relative or workspace-local module imports.
// Pure: no file system access; `importContext.ts` checks which candidate exists and is allowed.
import { posix } from 'node:path';
import { maskCode } from './mask';

export type ImportLanguage = 'ts' | 'python';

const LANGUAGES: Record<string, ImportLanguage> = {
  typescript: 'ts',
  typescriptreact: 'ts',
  javascript: 'ts',
  javascriptreact: 'ts',
  python: 'python',
};

export function importLanguage(languageId: string): ImportLanguage | undefined {
  return LANGUAGES[languageId];
}

/** What a file is imported for: the named declarations, the default export, or everything. */
export interface Wanted {
  /** Undefined: every declaration (namespace, module or CommonJS import). */
  names?: string[];
  default?: boolean;
}

export interface ImportRef {
  specifier: string;
  wanted: Wanted;
}

/**
 * Import statements are looked for in the document's first 64 KiB only: the parsing is
 * synchronous and no deadline can stop it (security review S1).
 */
export const IMPORT_SCAN_CHARS = 64 * 1024;

/** Characters read after a keyword for one statement: a longer statement is not read. */
const STATEMENT_CHARS = 1000;

const WORD_CHAR = /[\w$]/;

function isWordAt(text: string, index: number, word: string): boolean {
  return (
    text.startsWith(word, index) &&
    !WORD_CHAR.test(text[index - 1] ?? '') &&
    !WORD_CHAR.test(text[index + word.length] ?? '')
  );
}

function skipSpace(text: string, from: number, end: number): number {
  let i = from;
  while (i < end && /\s/.test(text[i]!)) i++;
  return i;
}

/**
 * A quoted specifier at `index` of the masked text (its quotes stay, its content is blank), read
 * from the original text: at most 500 characters on one line.
 */
function quoted(
  text: string,
  masked: string,
  index: number,
): { value: string; end: number } | undefined {
  const quote = masked[index];
  if (quote !== "'" && quote !== '"') return undefined;
  const close = masked.slice(index + 1, index + 502).indexOf(quote);
  if (close < 0) return undefined;
  const value = text.slice(index + 1, index + 1 + close);
  return value.includes('\n') ? undefined : { value, end: index + 2 + close };
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

function tsClause(clause: string): Wanted | undefined {
  const text = clause.replace(/\s+/g, ' ').trim();
  if (text === '') return undefined;
  if (/\*\s*as\s/.test(text)) return {};
  const wanted: Wanted = { names: [] };
  const brace = text.indexOf('{');
  const head = (brace < 0 ? text : text.slice(0, brace)).replace(/,\s*$/, '').trim();
  if (head !== '' && IDENT.test(head)) wanted.default = true;
  if (brace >= 0) {
    const inner = text.slice(
      brace + 1,
      text.indexOf('}', brace) < 0 ? undefined : text.indexOf('}', brace),
    );
    for (const part of inner.split(',')) {
      const name = part
        .trim()
        .replace(/^type\s+/, '')
        .split(/\s+as\s+/)[0]!
        .trim();
      if (IDENT.test(name)) wanted.names!.push(name === 'default' ? 'default' : name);
    }
    if (wanted.names!.includes('default')) {
      wanted.default = true;
      wanted.names = wanted.names!.filter((n) => n !== 'default');
    }
  }
  return wanted;
}

function isLocalSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../')
  );
}

/** `import … from '<specifier>'` starting at `at` (the keyword), within one statement window. */
function esmAt(text: string, masked: string, at: number): ImportRef | undefined {
  const end = Math.min(masked.length, at + STATEMENT_CHARS);
  let i = skipSpace(masked, at + 'import'.length, end);
  if (i === at + 'import'.length && masked[i] !== '{' && masked[i] !== '*') return undefined;
  if (isWordAt(masked, i, 'type')) {
    const next = skipSpace(masked, i + 4, end);
    // `import type from './x'` imports a default export named `type`.
    if (!isWordAt(masked, next, 'from')) i = next;
  }
  // The clause runs to `from` outside braces; a quote or `;` first means no `from` clause.
  let depth = 0;
  let k = i;
  for (; k < end; k++) {
    const c = masked[k]!;
    if (c === ';' || c === "'" || c === '"' || c === '`' || c === '(') return undefined;
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && c === 'f' && k > i && isWordAt(masked, k, 'from')) break;
  }
  if (k >= end) return undefined;
  const wanted = tsClause(masked.slice(i, k));
  const specifier = quoted(text, masked, skipSpace(masked, k + 4, end));
  if (!wanted || !specifier || !isLocalSpecifier(specifier.value)) return undefined;
  return { specifier: specifier.value, wanted };
}

/** `const|let|var <binding> = require('<specifier>')` around the keyword `require` at `at`. */
function requireAt(text: string, masked: string, at: number): ImportRef | undefined {
  let i = skipSpace(masked, at + 'require'.length, at + 60);
  if (masked[i] !== '(') return undefined;
  i = skipSpace(masked, i + 1, i + 60);
  const specifier = quoted(text, masked, i);
  if (!specifier || !isLocalSpecifier(specifier.value)) return undefined;
  if (masked[skipSpace(masked, specifier.end, specifier.end + 60)] !== ')') return undefined;
  // The binding: back over `=` to the nearest `const`, `let` or `var`, within 300 characters.
  const stop = Math.max(0, at - 300);
  let b = at - 1;
  while (b >= stop && /\s/.test(masked[b]!)) b--;
  if (masked[b] !== '=' || masked[b - 1] === '=' || masked[b - 1] === '!') return undefined;
  const before = masked.slice(stop, b);
  let keyword = -1;
  let length = 0;
  for (const word of ['const', 'let', 'var']) {
    let found = before.lastIndexOf(word);
    // Every step moves left or ends: lastIndexOf(word, -1) would find offset 0 again (CTX-I010).
    while (found >= 0 && !isWordAt(before, found, word)) {
      found = found === 0 ? -1 : before.lastIndexOf(word, found - 1);
    }
    if (found > keyword) {
      keyword = found;
      length = word.length;
    }
  }
  if (keyword < 0) return undefined;
  const binding = before.slice(keyword + length).trim();
  if (binding === '' || binding.includes(';')) return undefined;
  const wanted: Wanted = binding.startsWith('{')
    ? {
        names: binding
          .slice(1, binding.lastIndexOf('}'))
          .split(',')
          .map((part) => part.split(':')[0]!.trim())
          .filter((name) => IDENT.test(name)),
      }
    : {};
  return { specifier: specifier.value, wanted };
}

/**
 * Local TS/JS imports by a linear scan of the masked text (an import inside a string or comment is
 * none; the specifier is read from the original at the same offsets): each `import` or `require`
 * keyword is parsed within a bounded window, so no input makes the work superlinear (security
 * review S1, inspection CTX-I007).
 */
function tsImports(text: string, masked: string, maxImports: number): ImportRef[] {
  const found: ImportRef[] = [];
  for (let i = 0; i < masked.length && found.length < maxImports; i++) {
    const c = masked[i]!;
    let ref: ImportRef | undefined;
    if (c === 'i' && isWordAt(masked, i, 'import')) ref = esmAt(text, masked, i);
    else if (c === 'r' && isWordAt(masked, i, 'require')) ref = requireAt(text, masked, i);
    if (ref) found.push(ref);
  }
  return found;
}

function pythonNames(list: string): string[] | undefined {
  const text = list.replace(/[()\\]/g, ' ').trim();
  if (text === '*') return undefined;
  return text
    .split(',')
    .map((part) =>
      part
        .trim()
        .split(/\s+as\s+/)[0]!
        .trim(),
    )
    .filter((name) => /^[A-Za-z_]\w*$/.test(name));
}

/**
 * Python `from … import …` and `import …` statements by a line scan, each bounded: at most 20
 * leading dots, a module name of 200 characters, and a name list of 2000 characters over at most
 * 50 lines (parentheses or backslash continuations) (S1, CTX-I007).
 */
function pythonImports(masked: string, maxImports: number): ImportRef[] {
  const lines = masked.split('\n');
  const refs: ImportRef[] = [];
  let statements = 0;
  for (let n = 0; n < lines.length && statements < maxImports; n++) {
    const line = lines[n]!.trimStart();
    if (/^from[ \t]/.test(line)) {
      let i = skipSpace(line, 4, line.length);
      let dots = 0;
      while (line[i] === '.' && dots <= 20) {
        dots++;
        i++;
      }
      if (dots > 20) continue;
      const moduleStart = i;
      if (/[A-Za-z_]/.test(line[i] ?? '')) {
        while (i < line.length && i - moduleStart < 200 && /[\w.]/.test(line[i]!)) i++;
      }
      const module = line.slice(moduleStart, i);
      if (dots === 0 && module === '') continue;
      const before = i;
      i = skipSpace(line, i, line.length);
      if (i === before || !isWordAt(line, i, 'import')) continue;
      let list = line.slice(skipSpace(line, i + 6, line.length));
      // Continuation lines: an open parenthesis or a trailing backslash.
      let extra = 0;
      while (
        extra < 50 &&
        list.length < 2000 &&
        n + 1 < lines.length &&
        ((list.includes('(') && !list.includes(')')) || list.trimEnd().endsWith('\\'))
      ) {
        n++;
        extra++;
        list += `\n${lines[n]!}`;
      }
      if (list.length > 2000) continue;
      statements++;
      const dotted = '.'.repeat(dots);
      const names = pythonNames(list);
      if (module === '' && names) {
        // `from . import a, b`: each name may be a module of the package, or a name of __init__.py.
        for (const name of names) refs.push({ specifier: `${dotted}${name}`, wanted: {} });
      }
      refs.push({ specifier: `${dotted}${module}`, wanted: names ? { names } : {} });
    } else if (/^import[ \t]/.test(line)) {
      const list = line.slice(6, 2006);
      statements++;
      for (const part of list.split(',')) {
        const module = part
          .trim()
          .split(/[ \t]+as[ \t]+/)[0]!
          .trim();
        if (/^[A-Za-z_][\w.]{0,200}$/.test(module)) refs.push({ specifier: module, wanted: {} });
      }
    }
  }
  return refs;
}

/**
 * The document's local import statements in source order, at most `maxImports` of them, from its
 * first IMPORT_SCAN_CHARS characters.
 */
export function parseImports(
  text: string,
  language: ImportLanguage,
  maxImports: number,
): ImportRef[] {
  const head = text.slice(0, IMPORT_SCAN_CHARS);
  const masked = maskCode(head, language);
  const refs =
    language === 'ts' ? tsImports(head, masked, maxImports) : pythonImports(masked, maxImports);
  return refs.slice(0, maxImports);
}

const TS_EXTENSIONS = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/** A folder-relative POSIX path, or undefined when it leaves the folder. */
function inside(path: string): string | undefined {
  const normal = posix.normalize(path);
  if (normal === '..' || normal.startsWith('../') || posix.isAbsolute(normal)) return undefined;
  return normal === '.' ? '' : normal;
}

/**
 * Folder-relative paths a specifier may name, in resolution order. `fromDir` is the document's
 * directory relative to its workspace folder ('' for the folder itself). Paths that leave the
 * folder are never returned.
 */
export function candidatePaths(
  language: ImportLanguage,
  specifier: string,
  fromDir: string,
): string[] {
  const out: string[] = [];
  const add = (path: string | undefined): void => {
    if (path !== undefined && path !== '' && !out.includes(path)) out.push(path);
  };
  if (language === 'ts') {
    const base = inside(posix.join(fromDir, specifier));
    if (base === undefined) return [];
    const extension = TS_EXTENSIONS.find((ext) => base.endsWith(ext) && base !== ext);
    if (extension) {
      for (const ts of JS_TO_TS[extension] ?? []) add(base.slice(0, -extension.length) + ts);
      add(base);
    } else {
      for (const ext of TS_EXTENSIONS) add(base === '' ? undefined : base + ext);
      for (const ext of TS_EXTENSIONS) add(base === '' ? `index${ext}` : `${base}/index${ext}`);
    }
    return out;
  }
  const dots = /^\.*/.exec(specifier)![0].length;
  const parts = specifier.slice(dots).split('.').filter(Boolean);
  const roots =
    dots > 0
      ? [inside(posix.join(fromDir, ...Array<string>(dots - 1).fill('..')))]
      : [inside(fromDir), ''];
  for (const root of roots) {
    if (root === undefined) continue;
    const module = posix.join(root || '.', ...parts);
    if (parts.length > 0) add(inside(`${module}.py`));
    add(inside(posix.join(module, '__init__.py')));
  }
  return out;
}
