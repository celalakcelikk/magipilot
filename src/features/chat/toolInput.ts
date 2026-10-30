// Whether a tool call's input names an excluded file (docs/plans/phase-4-tools.md T8, plan reviews
// P4T-R001, P4T-R003). vscode-free: the extension supplies the workspace roots, the pattern matcher
// and the file-system lookups, so the classification is tested with real files in vitest.
//
// This is the secondary check: the primary one is on the result side (the content net, also over
// search tools' prefixed lines). Shell syntax is open-ended, so where a command cannot be read with
// finite rules, the result counts as excluded (inspection round 1 and the automated security
// reviews of `085704d`, `c58d56c` and `ef80659`).
//
// A terminal's working folder is unknown to the provider (the user or an earlier chat may have
// changed it), so a command line's relative words are also checked from any folder, against the
// end of every excluded file's path, and under the folders that the conversation's own `cd`,
// `pushd`, `-C`, … name (docs/plans/phase-4-hardening.md AC6, plan reviews P4H-002 and P4H-003).
import { isAbsolute, join, posix, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globToRegExp } from '../../core/context/exclude';

export interface ToolInputDeps {
  /** Workspace folder paths (absolute). */
  roots: readonly string[];
  /** `magipilot.exclude` against a path, patterns only (no file-system lookup). */
  matches(path: string): boolean;
  /** The realpath of an existing entry; undefined when the path does not exist. */
  realpath(path: string): string | undefined;
  /** Whether an existing entry is a directory (false when it does not exist). */
  isDirectory?: (path: string) => boolean;
  /**
   * Every excluded file's path that the content net found, for wildcards and directory
   * arguments; `excludedPathsComplete` says whether it holds them all. Without both, a wildcard
   * or a directory argument counts as excluded.
   */
  excludedPaths?: ReadonlySet<string>;
  excludedPathsComplete?: boolean;
  /** The matcher's comparison form (case folding on darwin and win32). */
  key?: (text: string) => string;
  /**
   * Folders a command line may run in besides the roots: the ones that the conversation's command
   * calls change to (`commandFolders`). `foldersUnknown`: a change of folder could not be
   * resolved, so every command line counts as excluded (AC6 b).
   */
  commandFolders?: readonly string[];
  foldersUnknown?: boolean;
  /**
   * The names in an existing folder (undefined for anything else), so that a glob's matches are
   * checked by their realpath (inspection P4H-I003). Without it, globs are matched against the
   * excluded files only.
   */
  readdir?: (path: string) => string[] | undefined;
}

const MALFORMED = /[\n\r\0]/;

function explicitPathExcluded(path: string, deps: ToolInputDeps): boolean {
  if (deps.matches(path)) return true;
  // An absent path is judged by the patterns alone: a tool cannot read it.
  const real = deps.realpath(path);
  return real !== undefined && real !== path && deps.matches(real);
}

/** The folders a relative word is resolved under: the roots, and for a command line also the
 * folders its conversation changes to (AC6 b). */
function basesOf(deps: ToolInputDeps, command: boolean): readonly string[] {
  return command && deps.commandFolders?.length
    ? [...deps.roots, ...deps.commandFolders]
    : deps.roots;
}

/**
 * One value, classified first (T8):
 * 1. every value, as given, against the patterns only;
 * 2. a `file:` URI or an absolute path is explicit metadata: patterns, then the realpath of an
 *    existing entry; a malformed URI (unreadable, or a line break or NUL in its path) counts as
 *    excluded, while any other value with a line break or NUL is text (its words are checked);
 * 3. any other value may be relative: each candidate under a workspace root (for a command line,
 *    also under its conversation's folders) that exists is checked by its path and its realpath;
 *    absent candidates are ignored, so a search query excludes nothing by itself.
 */
function classifyValue(value: string, deps: ToolInputDeps, command: boolean): boolean {
  if (deps.matches(value)) return true;
  if (/^file:/i.test(value)) {
    let path: string;
    try {
      path = fileURLToPath(value);
    } catch {
      return true;
    }
    // A URI is explicit metadata: one with a line break or NUL in its path is malformed.
    return MALFORMED.test(path) || explicitPathExcluded(path, deps);
  }
  // A value with a line break or NUL is text, not a path (code that starts with `//`, say): a
  // tool cannot read such a path, and the paths inside the text are checked word by word.
  if (value === '' || MALFORMED.test(value)) return false;
  if (isAbsolute(value)) return explicitPathExcluded(value, deps);
  for (const root of basesOf(deps, command)) {
    const candidate = join(root, value);
    const real = deps.realpath(candidate);
    if (real === undefined) continue;
    if (deps.matches(candidate) || deps.matches(real)) return true;
  }
  return false;
}

/** Separators of a plain split (quotes separate too). */
const PLAIN_SEPARATORS = /[\s;|&<>()`'"=]+/;
/** Operators and separators outside quotes in the shell-like split. */
const SHELL_SEPARATOR = /[\s;|&<>()=]/;
/** Command substitution: what it reads cannot be known, so the value counts as excluded. */
const SUBSTITUTION = /\$\(|`/;
/** ANSI-C and locale quoting (`$'\x2e'`, `$"…"`): escapes this parser does not decode. */
const ANSI_QUOTE = /\$['"]/;
/**
 * Commands that search a folder recursively. Each counts as a search of the current folder, which
 * may be any folder of the workspace, whatever folders it names (decision D6 of the hardening
 * loop: path operands cannot be told from option values, patterns and redirections with finite
 * rules; inspections P4H-I001, P4H-RI001, P4H-RI002).
 */
const RECURSIVE_TOOLS = new Set([
  'rg',
  'ag',
  'ack',
  'ack-grep',
  'pt',
  'sift',
  'ugrep',
  'ug',
  'rgrep',
  'find',
  'gfind',
  'bfs',
  'fd',
  'fdfind',
  'tree',
]);
/**
 * grep and its variants (`egrep`, `ggrep`, `pcre2grep`, `zstdgrep`, …: any name that ends in
 * `grep`) and `ls`/`gls` are recursive with an option that may mean it (`mayRecurse`).
 */
function optionFamily(name: string): 'grep' | 'ls' | undefined {
  if (name.endsWith('grep')) return 'grep';
  return name === 'ls' || name === 'gls' ? 'ls' : undefined;
}

/**
 * Whether an option of grep or `ls` may make it recursive, read conservatively (automated security
 * review of `6c473a5`): a short cluster with `r`, `R` or grep's `d` (`-d recurse`, `-drecurse`),
 * and any long option that GNU getopt may expand to `--recursive`, `--dereference-recursive` or
 * `--directories` (`--rec`, `--dir=recurse`, `--directories recurse`). An option value that looks
 * like one only adds a match.
 */
function mayRecurse(tool: 'grep' | 'ls', word: string): boolean {
  if (word.startsWith('--')) {
    const name = word.split('=')[0]!;
    if (name.length < 3) return false;
    const longs =
      tool === 'grep'
        ? ['--recursive', '--dereference-recursive', '--directories']
        : ['--recursive'];
    return longs.some((long) => long.startsWith(name));
  }
  // Any short cluster, digits included (`grep -5r`, `ls -1R`).
  if (!/^-[^-]/.test(word)) return false;
  return (tool === 'grep' ? /[rRd]/ : /R/).test(word.slice(1));
}
/** Words that run other input as commands or file lists: they count as excluded. */
const INTERPRETERS = new Set([
  'xargs',
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  'fish',
  'eval',
  'source',
  'exec',
  '{}',
]);
/** A shell variable (`$X`, `${X}`); not global, so `test` keeps no state between calls. */
const VARIABLE = /\$\{[^}]*\}|\$\w+/;
const WILDCARD = /[*?[{]/;
/** Wildcard tokens per word, and word length, beyond which a word counts as excluded. */
const MAX_WILDCARDS = 8;
const MAX_WILDCARD_WORD = 512;
/** More distinct words than this (a huge input) count as excluded rather than as unchecked. */
const MAX_WORDS = 20_000;

/** Unquoted characters that end a simple command (`cd src && cat x` is two). */
const COMMAND_END = /[;&|()\n]/;

/**
 * A POSIX-like split that keeps quoted and escaped whitespace inside a word (`"sp ace/x"`,
 * `sp\ ace/x`) and drops the quotes. Undefined when a quote is not closed.
 */
function shellWords(value: string): string[] | undefined {
  return shellCommands(value)?.flat();
}

/**
 * `shellWords`, grouped by simple command (split at unquoted `;`, `&`, `|`, `(`, `)`, newline).
 * With `splitEquals` off, `=` stays inside a word (`--include=src` is one option).
 */
function shellCommands(value: string, splitEquals = true): string[][] | undefined {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let inWord = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quote === "'") {
      if (char === "'") quote = undefined;
      else word += char;
    } else if (quote === '"') {
      if (char === '"') quote = undefined;
      else if (char === '\\' && i + 1 < value.length) {
        // A backslash-newline is a line continuation: both go (`GREP_OPT\⏎IONS`).
        const next = value[++i]!;
        if (next !== '\n') word += next;
      } else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === '\\' && i + 1 < value.length) {
      const next = value[++i]!;
      if (next !== '\n') {
        word += next;
        inWord = true;
      }
    } else if (SHELL_SEPARATOR.test(char) && (splitEquals || char !== '=')) {
      if (inWord) words.push(word);
      word = '';
      inWord = false;
      if (COMMAND_END.test(char) && words.length > 0) {
        commands.push(words);
        words = [];
      }
    } else {
      word += char;
      inWord = true;
    }
  }
  if (quote !== undefined) return undefined;
  if (inWord) words.push(word);
  if (words.length > 0) commands.push(words);
  return commands;
}

/**
 * The words of a value, in three readings: a plain split (quotes separate), the same with quotes
 * and escapes removed (`'.e'nv` joined), and the shell-like split (quoted spaces kept). Lists
 * (`a,b`) are split too. Undefined for a command line whose quote is not closed.
 */
function wordsOf(value: string, command: boolean): Set<string> | undefined {
  const shell = shellWords(value);
  // An unclosed quote: a command line cannot be read safely; a query (`don't`) can.
  if (shell === undefined && command) return undefined;
  const unquoted = value.replace(/\\\n/g, '').replace(/\\(.)/gs, '$1').replace(/['"]/g, '');
  const words = new Set<string>();
  const add = (token: string): void => {
    if (token === '') return;
    words.add(token);
    if (token.includes(',')) for (const part of token.split(',')) if (part !== '') words.add(part);
  };
  for (const form of [value, unquoted])
    for (const token of form.split(PLAIN_SEPARATORS)) add(token);
  for (const token of shell ?? []) add(token);
  words.delete(value);
  return words;
}

function under(path: string, directory: string, key: (text: string) => string): boolean {
  const dir = key(directory.endsWith(sep) ? directory : directory + sep);
  return key(path).startsWith(dir);
}

/**
 * The places a word of a command line may name: as given when absolute, else under every workspace
 * root and every folder its conversation changes to.
 */
function candidatesOf(word: string, deps: ToolInputDeps): string[] {
  return isAbsolute(word) ? [word] : basesOf(deps, true).map((root) => join(root, word));
}

/**
 * A relative word made independent of the folder it runs in (AC6 a): normalized lexically, with
 * its leading `./` and `../` segments and a trailing slash removed. Undefined when nothing is left
 * (`.`, `..`): the folder itself, which `directoryExcluded` covers.
 */
function tailOf(word: string): string | undefined {
  let tail = posix.normalize(word);
  while (tail.startsWith('../')) tail = tail.slice(3);
  if (tail.endsWith('/')) tail = tail.slice(0, -1);
  return tail === '' || tail === '.' || tail === '..' ? undefined : tail;
}

/**
 * Whether a relative word of a command line can name an excluded file from any folder (AC6 a): an
 * excluded file's path (lexical or realpath) ends with it. The caller makes sure that the list is
 * complete.
 */
function tailExcluded(word: string, deps: ToolInputDeps): boolean {
  if (isAbsolute(word) || !deps.excludedPaths) return false;
  const tail = tailOf(word);
  if (tail === undefined) return false;
  const key = deps.key ?? ((text: string): string => text);
  const end = key(sep + tail);
  for (const path of deps.excludedPaths) if (key(path).endsWith(end)) return true;
  return false;
}

/**
 * A word of a command line that names an existing directory with an excluded file beneath it
 * (`grep -r KEY .`, `cat secrets/`): a recursive command reaches that file.
 */
function directoryExcluded(word: string, deps: ToolInputDeps): boolean {
  if (!deps.isDirectory) return false;
  const key = deps.key ?? ((text: string): string => text);
  for (const candidate of candidatesOf(word, deps)) {
    if (!deps.isDirectory(candidate)) continue;
    if (!deps.excludedPaths || !deps.excludedPathsComplete) return true;
    const real = deps.realpath(candidate) ?? candidate;
    for (const path of deps.excludedPaths) {
      if (under(path, candidate, key) || under(path, real, key)) return true;
    }
  }
  return false;
}

const MAX_EXPANSIONS = 64;

/**
 * The words a shell's brace expansion makes of `word` (`a{b,c}d` → `abd`, `acd`; nested lists
 * too). A group without a top-level comma stays literal, as in a shell. Undefined (counted as
 * excluded) beyond `MAX_EXPANSIONS` words, for a range (`{a..z}`, `s{e..e}crets`; re-inspection
 * PUB-RI001), and for a word longer than `MAX_WILDCARD_WORD`, which bounds the scan
 * (re-inspection PUB-RI002).
 */
function expandBraces(word: string): string[] | undefined {
  if (word.length > MAX_WILDCARD_WORD) return undefined;
  if (/\{[^{}]*\.\.[^{}]*\}/.test(word)) return undefined;
  const done: string[] = [];
  const pending = [word];
  while (pending.length > 0) {
    const current = pending.pop()!;
    const group = firstBraceList(current);
    if (!group) {
      done.push(current);
    } else {
      for (const alternative of group.alternatives) {
        pending.push(current.slice(0, group.start) + alternative + current.slice(group.end + 1));
      }
    }
    if (done.length + pending.length > MAX_EXPANSIONS) return undefined;
  }
  return done;
}

/** The first `{…,…}` group of `word` with its top-level alternatives. */
function firstBraceList(
  word: string,
): { start: number; end: number; alternatives: string[] } | undefined {
  for (let start = word.indexOf('{'); start >= 0; start = word.indexOf('{', start + 1)) {
    let depth = 0;
    const commas: number[] = [];
    for (let i = start; i < word.length; i++) {
      const char = word[i];
      if (char === '{') depth++;
      else if (char === ',' && depth === 1) commas.push(i);
      else if (char === '}' && --depth === 0) {
        if (commas.length === 0) break;
        const alternatives: string[] = [];
        let from = start + 1;
        for (const comma of commas) {
          alternatives.push(word.slice(from, comma));
          from = comma + 1;
        }
        alternatives.push(word.slice(from, i));
        return { start, end: i, alternatives };
      }
    }
  }
  return undefined;
}

/** Whether a glob segment is, or can match, `.` or `..` (a shell matches a leading dot only literally). */
function mayBeDotSegment(segment: string): boolean {
  if (segment === '.' || segment === '..') return true;
  if (!/^[.[{]/.test(segment)) return false;
  const regex = globToRegExp(segment);
  return regex.test('.') || regex.test('..');
}

/** Entries listed per glob before it counts as excluded (inspection P4H-I003). */
const MAX_GLOB_ENTRIES = 4096;

/**
 * The existing entries that a glob without `**` matches under `base`, listed folder by folder as a
 * shell expands it (dot files match too, which only adds entries). Undefined once `budget` runs
 * out.
 */
function globEntries(
  base: string,
  glob: string,
  deps: ToolInputDeps,
  budget: { left: number },
): string[] | undefined {
  const key = deps.key ?? ((text: string): string => text);
  let frontier = [base];
  for (const segment of glob.split('/')) {
    if (segment === '') continue;
    if (!WILDCARD.test(segment)) {
      frontier = frontier.map((folder) => join(folder, segment));
      continue;
    }
    const regex = globToRegExp(key(segment));
    const next: string[] = [];
    for (const folder of frontier) {
      const names = deps.readdir!(folder);
      if (names === undefined) continue;
      budget.left -= names.length;
      if (budget.left < 0) return undefined;
      for (const name of names) if (regex.test(key(name))) next.push(join(folder, name));
    }
    frontier = next;
  }
  return frontier;
}

/**
 * A word with wildcards or variables (`*`, `?`, `[…]`, `{a,b}`, `$X`) against the excluded files
 * the content net found, resolved as a shell would: absolute, or under each root, with the realpath of its fixed
 * directory part too; for a command line also from any folder (AC6 a). A glob without `**` is
 * also expanded from the folder listings, and each match is checked by its realpath, so a symlink
 * with another name is caught (inspection P4H-I003). Without a complete list, or with too many
 * wildcards or matches for a bounded check, it counts as excluded.
 */
function wildcardExcluded(word: string, deps: ToolInputDeps, command: boolean): boolean {
  // In a command line a variable stands for anything; in a query `$` is just a character.
  if (!WILDCARD.test(word) && !(command && word.includes('$'))) return false;
  // Outside a command line a multi-line value is text, such as code in an edit's input, not a
  // pattern (re-inspection fix: a code block must not count as a wildcard that fails closed). A
  // single-line value is matched as one glob (security review of 3d35f7f).
  if (!command && MALFORMED.test(word)) return false;
  if (!deps.excludedPaths || !deps.excludedPathsComplete) return true;
  if (deps.excludedPaths.size === 0) return false;
  if (word.length > MAX_WILDCARD_WORD) return true;
  // An unquoted variable in a command line can hold anything, slashes and spaces included
  // (`$D/secrets/key`, `src/x$F.ts` with F="/../../.env "), so a word with one counts as
  // excluded whenever the workspace has an excluded file (security review of f310246).
  if (command && VARIABLE.test(word)) return true;
  const glob = word.replace(/\[[^\]]*\]/g, '?').replace(/(?:\*\*\/)+/g, '**/');
  if ((glob.match(/[*?{]/g) ?? []).length > MAX_WILDCARDS) return true;
  const key = deps.key ?? ((text: string): string => text);
  // The glob splits into its fixed folder part (no wildcards) and the pattern after it. The
  // folder is resolved as a path (lexically and by realpath: a symlinked folder, or a root
  // reached through a symlink such as /tmp on macOS; re-inspection P4T-RI002); only the pattern
  // becomes a regular expression, so wildcard characters in a root's own name stay literal.
  const slash = glob.lastIndexOf('/', glob.search(/[*?{]/));
  const fixed = slash >= 0 ? glob.slice(0, slash) : '';
  const pattern = slash >= 0 ? glob.slice(slash + 1) : glob;
  // A segment of the pattern that is or can match `.` or `..` moves out of the fixed folder
  // (`src/*/../.env`, `src/*/.*/x`, `src/*/{..,a}/x`): the pattern alone cannot say where it
  // lands, so the word counts as excluded (security reviews of 2466635 and 0bd9302). As in a
  // shell, only a segment that can start with a dot can match one. The fixed part is normalized
  // by `join`.
  if (pattern.split(/[/\\]/).some(mayBeDotSegment)) return true;
  const regex = globToRegExp(key(pattern));
  const excluded = deps.excludedPaths;
  const folders = isAbsolute(glob)
    ? [fixed === '' ? sep : fixed]
    : basesOf(deps, command).map((root) => (fixed === '' ? root : join(root, fixed)));
  for (const folder of folders) {
    const forms = new Set([folder]);
    const real = deps.realpath(folder);
    if (real !== undefined) forms.add(real);
    for (const form of forms) {
      const prefix = key(form.endsWith(sep) ? form : form + sep);
      for (const path of excluded) {
        const candidate = key(path);
        if (candidate.startsWith(prefix) && regex.test(candidate.slice(prefix.length))) return true;
      }
    }
  }
  // From any folder (AC6 a): the whole relative glob against the end of each excluded path, at a
  // folder boundary (`cat *` inside `secrets/`). Its fixed part goes through `tailOf`; a `..` that
  // `tailOf` cannot remove (`a/*/../x`) was refused above.
  const tail = command && !isAbsolute(glob) ? tailOf(glob) : undefined;
  if (tail !== undefined) {
    const whole = globToRegExp(key(tail));
    for (const path of excluded) {
      const candidate = key(path);
      for (let at = candidate.indexOf(sep); at >= 0; at = candidate.indexOf(sep, at + 1)) {
        if (whole.test(candidate.slice(at + 1))) return true;
      }
    }
  }
  // The glob's matches, by their realpath (P4H-I003). A `**` glob is not listed: it would read the
  // whole workspace for every search pattern (a documented residual).
  if (deps.readdir && !glob.includes('**')) {
    const expanded = expandBraces(glob);
    if (expanded === undefined) return true;
    const budget = { left: MAX_GLOB_ENTRIES };
    const bases = isAbsolute(glob) ? [sep] : basesOf(deps, command);
    for (const each of expanded) {
      for (const base of bases) {
        const entries = globEntries(base, each, deps, budget);
        if (entries === undefined) return true;
        for (const entry of entries) {
          const real = deps.realpath(entry);
          if (real === undefined) continue;
          if (explicitPathExcluded(entry, deps) || excluded.has(real) || excluded.has(entry)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

/** The recursive search tool of a simple command and its position, if any. */
function recursiveTool(words: readonly string[]): { tool: string; at: number } | undefined {
  for (let i = 0; i < words.length; i++) {
    const name = words[i]!.split('/').at(-1) ?? '';
    if (name === 'git') {
      const at = words.indexOf('grep', i + 1);
      if (at > i) return { tool: 'git grep', at };
      continue;
    }
    if (RECURSIVE_TOOLS.has(name)) return { tool: name, at: i };
    const family = optionFamily(name);
    if (family && words.slice(i + 1).some((word) => mayRecurse(family, word))) {
      return { tool: name, at: i };
    }
  }
  return undefined;
}

/**
 * A checker for the string values of tool inputs (T8), memoized for one request. `command` says
 * whether the value is a command line (the caller decides from the tool's name and the key).
 *
 * Every value is classified as a whole and with each of its words (three readings, `wordsOf`),
 * and words with wildcards are matched against the excluded files. A command line gets finite
 * fail-closed rules on top: command substitution, an unclosed quote, a word that runs other input
 * (`xargs`, `sh`, `eval`, `{}`, …), a variable, and a directory argument with an excluded file
 * beneath it, and any recursive search while a workspace folder holds an excluded file (D6). Its
 * relative words are also checked from any folder (AC6 a) and under the folders
 * its conversation changes to (AC6 b); without a complete list of excluded files, or with a change
 * of folder that could not be resolved, a command line counts as excluded. A value with more than
 * `MAX_WORDS` words counts as excluded.
 */
export function toolInputChecker(
  given: ToolInputDeps,
): (value: string, command: boolean) => boolean {
  const deps = withRealExcludedPaths(given);
  const memo = new Map<string, boolean>();
  const check = (word: string, command: boolean, single: boolean): boolean => {
    const id = `${command ? 'c' : 'v'}${single ? 's' : 'w'}${word}`;
    let excluded = memo.get(id);
    if (excluded === undefined) {
      // In a command line, brace lists are expanded as a shell does, so `src/{../,x/}secrets/key`
      // is checked as the paths it names (inspection PUB-I001). A value that is not a command is
      // not expanded: code in an edit's input is full of `{a, b}` (re-inspection fix).
      const expansions = command && word.includes('{') ? expandBraces(word) : [word];
      excluded =
        expansions === undefined ||
        (expansions.length > 1 && expansions.some((each) => check(each, command, single))) ||
        classifyValue(word, deps, command) ||
        // From any folder: the working folder of a command line is unknown (AC6 a).
        (command && !WILDCARD.test(word) && tailExcluded(word, deps)) ||
        // The words of a value that is not a command are text, not globs.
        ((command || single) && wildcardExcluded(word, deps, command)) ||
        // A directory argument of a command line (not a value that is one path: listing a folder
        // reads no excluded content).
        (command && !single && (INTERPRETERS.has(word) || directoryExcluded(word, deps)));
      memo.set(id, excluded);
    }
    return excluded;
  };
  return (value, command) => {
    // The folder-independent checks need every excluded file (AC6).
    if (command && (deps.foldersUnknown || !deps.excludedPaths || !deps.excludedPathsComplete)) {
      return true;
    }
    if (check(value, command, true)) return true;
    if (command && (SUBSTITUTION.test(value) || ANSI_QUOTE.test(value))) return true;
    const words = wordsOf(value, command);
    if (words === undefined || words.size > MAX_WORDS) return true;
    for (const word of words) if (check(word, command, false)) return true;
    // A recursive search reaches every excluded file below the current folder, and that folder is
    // unknown: whatever folders it names, it counts as excluded whenever a workspace folder holds
    // an excluded file (D6). Simple commands are read without splitting at `=`, so that
    // `--directories=recurse` stays one option.
    if (
      command &&
      (shellCommands(value, false) ?? []).some((words) => recursiveTool(words) !== undefined) &&
      directoryExcluded('.', deps)
    ) {
      return true;
    }
    return false;
  };
}

/** Commands that change the shell's folder (`chdir` is zsh's). */
const CHANGE_FOLDER = new Set(['cd', 'pushd', 'chdir']);
/** Words that change the folder of one command, followed by that folder. */
const FOLDER_FLAGS = new Set(['-C', '--prefix', '--cwd', '--dir', '--directory']);
/** `cd`'s and `pushd`'s own options, skipped before the folder. */
const CD_OPTION = /^-[LPe@]+$/;
/** At most this many folders besides the roots; more count as unknown. */
const MAX_COMMAND_FOLDERS = 32;
/** A function definition outside quotes, whatever its body (`f() { … }`, zsh's `f() cmd`). */
const FUNCTION_DEFINITION = /[^\s;&|()<>]\s*\(\s*\)/;
/** Words that set shell state a later command line may depend on, after quote removal. */
const SHELL_STATE_WORDS = new Set(['alias', 'unalias', 'function', 'eval']);
/**
 * Words that run the next word as the command; the command word is looked for after them and
 * their options (`command -p $c`). The shell's own (`builtin`, `command`, `time`, `noglob`, …)
 * can run a builtin that sets state; an external one (`env`, `nice`, `sudo`) runs a separate
 * program, which cannot, and is listed only to look past it.
 */
const COMMAND_WRAPPERS = new Set([
  'builtin',
  'command',
  'exec',
  'time',
  'noglob',
  'nocorrect',
  '-',
  'env',
  'nohup',
  'nice',
  'sudo',
]);

/**
 * Whether a command line may set shell state that a later one depends on (automated security
 * reviews of `6c473a5`, `a75fdf4` and `84b3ca2`):
 * - `alias`, `unalias`, `function` or `eval` as any word after quote and escape removal and
 *   brace expansion (`\alias`, `"eval"`, `al''ias`, `{alias,}` too; a quoted pattern
 *   `grep 'alias' x` also counts), and a brace list that cannot be expanded;
 * - a function definition outside quotes, whatever its body;
 * - `GREP_OPTIONS` (BSD grep reads it) in the line with quotes and escapes removed;
 * - an assignment whose name holds an expansion (`env $V=-r`, `export ${V}=-r`);
 * - an expansion or a brace list as the command word (`$c g=ls`), also after a wrapper such as
 *   `command -p`.
 */
function setsShellState(command: string, simple: readonly (readonly string[])[]): boolean {
  if (FUNCTION_DEFINITION.test(outsideQuotes(command))) return true;
  const dequoted = command.replace(/\\\n/g, '').replace(/\\(.)/gs, '$1').replace(/['"]/g, '');
  if (/GREP_OPTIONS/.test(dequoted)) return true;
  for (const words of simple) {
    for (const word of words) {
      // Brace expansion comes before the command is looked up: `{alias,} g=ls` runs `alias`.
      const expansions = word.includes('{') ? expandBraces(word) : [word];
      if (expansions === undefined) return true;
      if (expansions.some((each) => SHELL_STATE_WORDS.has(each) || /GREP_OPTIONS/.test(each))) {
        return true;
      }
    }
    if (words.some((word) => /^[^=]*[$`][^=]*=/.test(word))) return true;
    // Past assignments, wrappers and, after a wrapper, options and further assignments
    // (`time X=1 $c`, `command -p $c`), in any order.
    let at = 0;
    let wrapped = false;
    while (at < words.length) {
      const word = words[at]!;
      if (COMMAND_WRAPPERS.has(word)) wrapped = true;
      else if (!/^\w+=/.test(word) && !(wrapped && word.startsWith('-'))) break;
      at++;
    }
    const commandWord = words[at];
    if (commandWord !== undefined && /[$`]/.test(commandWord)) return true;
    if (commandWord !== undefined && (expandBraces(commandWord)?.length ?? 2) > 1) return true;
  }
  return false;
}

/** A command line with the contents of its quotes replaced by `_`, quotes and escapes kept out. */
function outsideQuotes(value: string): string {
  let out = '';
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else if (quote === '"' && char === '\\') i++;
      out += '_';
    } else if (char === "'" || char === '"') {
      quote = char;
      out += '_';
    } else if (char === '\\') {
      i++;
      out += '_';
    } else {
      out += char;
    }
  }
  return out;
}

/**
 * The folders that the conversation's command lines change to (AC6 b): the target of `cd`,
 * `chdir` and `pushd`, a folder given alone as the command (zsh's `auto_cd`), and the folder
 * after `-C`, `--prefix`, `--cwd`, `--dir` and `--directory` (also attached, `-Csrc`, and
 * `--dir=src`). Each relative target is resolved under the roots and under the folders found so
 * far, in any order, until nothing new is found; only existing folders count, in their lexical
 * and their realpath form. `unknown` when a target cannot be resolved (a variable, a substitution,
 * a wildcard, `~`, `cd` alone, `cd -`, a stack rotation, zsh's `cd old new`), when a quote is not
 * closed, when an input could not be read to the end (`commands` undefined), beyond
 * `MAX_COMMAND_FOLDERS`, and when a command line defines an alias or a function, runs `eval` or
 * names `GREP_OPTIONS`. Aliases and functions from files the shell reads (startup files,
 * `source`) are not seen (a documented residual).
 */
export function commandFolders(
  commands: readonly string[] | undefined,
  deps: Pick<ToolInputDeps, 'roots' | 'realpath' | 'isDirectory'>,
): { folders: string[]; unknown: boolean } {
  const unknown = { folders: [], unknown: true };
  if (commands === undefined) return unknown;
  const targets = new Set<string>();
  for (const command of commands) {
    const simple = shellCommands(command);
    if (simple === undefined) return unknown;
    // Shell state can change what a later command line does, so the conversation's command
    // lines cannot be read (`setsShellState`). Read without splitting at `=`.
    if (setsShellState(command, shellCommands(command, false) ?? [])) return unknown;
    for (const words of simple) {
      for (let i = 0; i < words.length; i++) {
        const word = words[i]!;
        let target: string | undefined;
        if (CHANGE_FOLDER.has(word)) {
          let next = i + 1;
          while (next < words.length && (CD_OPTION.test(words[next]!) || words[next] === '--')) {
            next++;
          }
          target = words[next];
          if (target === undefined || target === '-' || /^[+-]\d+$/.test(target)) return unknown;
          // zsh's `cd old new` replaces `old` with `new` in the current folder's path.
          if (word !== 'pushd' && words[next + 1] !== undefined) return unknown;
        } else if (i === 0 && words.length === 1) {
          // zsh's `auto_cd`: a folder given alone as the command changes to it. A word that names no
          // existing folder is dropped below; one that cannot be resolved is no folder change
          // Magipilot can see (`$EDITOR x`, `~/bin/tool`: the documented residual).
          if (!/[$`~*?[{]/.test(word)) targets.add(word);
          continue;
        } else if (FOLDER_FLAGS.has(word)) {
          target = words[i + 1];
        } else if (/^-C./.test(word)) {
          target = word.slice(2);
        }
        if (target === undefined) continue;
        if (/[$`~*?[{]/.test(target)) return unknown;
        targets.add(target);
      }
    }
  }
  const roots = new Set(deps.roots);
  const found = new Set<string>();
  let added = true;
  while (added) {
    added = false;
    for (const target of targets) {
      const bases = isAbsolute(target) ? [''] : [...roots, ...found];
      for (const base of bases) {
        const candidate = base === '' ? target : join(base, target);
        if (!deps.isDirectory?.(candidate)) continue;
        for (const form of [candidate, deps.realpath(candidate) ?? candidate]) {
          if (roots.has(form) || found.has(form)) continue;
          found.add(form);
          added = true;
          if (found.size > MAX_COMMAND_FOLDERS) return unknown;
        }
      }
    }
  }
  return { folders: [...found], unknown: false };
}

/**
 * The command lines among the tool calls' inputs (`isCommandValue`), for `commandFolders`;
 * undefined when an input is nested deeper than `MAX_DEPTH`, so that its changes of folder count
 * as unknown.
 */
export function commandValues(
  calls: Iterable<{ name: string; input: unknown }>,
): string[] | undefined {
  const values: string[] = [];
  for (const call of calls) {
    // `inputExcluded` reports true only for an input deeper than MAX_DEPTH: the callback never does.
    const tooDeep = inputExcluded(call.input, (value, key) => {
      if (isCommandValue(call.name, key)) values.push(value);
      return false;
    });
    if (tooDeep) return undefined;
  }
  return values;
}

/**
 * The deps with every excluded path also in its realpath form, so that a candidate resolved
 * through a symlink compares with a path found lexically, and the other way round (re-inspection
 * P4T-RI002).
 */
function withRealExcludedPaths(deps: ToolInputDeps): ToolInputDeps {
  if (!deps.excludedPaths || deps.excludedPaths.size === 0) return deps;
  const both = new Set(deps.excludedPaths);
  for (const path of deps.excludedPaths) {
    const real = deps.realpath(path);
    if (real !== undefined) both.add(real);
  }
  return { ...deps, excludedPaths: both };
}

/** One value with a fresh checker (tests). */
export function isExcludedToolValue(value: string, deps: ToolInputDeps, command = false): boolean {
  return toolInputChecker(deps)(value, command);
}

/**
 * Tools that run commands or code, by name: Copilot Chat's terminal and task tools, notebooks, MCP
 * shells and interpreters. Tools that read, search or edit files are not commands: their inputs
 * hold code and text, which the command rules would drop for every quote or `$` (a recorded
 * trade-off, docs/plans/phase-4-tools-review.md).
 */
const COMMAND_TOOL =
  /terminal|shell|command|exec|bash|task|notebook|python|interpreter|run_?(?:in|cell|code|script)/i;
/** Input keys that hold a command line or code to run. */
const COMMAND_KEY =
  /^(?:command|commands|cmd|commandLine|script|shellCommand|args|argv|code|cell|program)$/i;

/** Whether a value of tool `toolName` under `key` is read as a command line. */
export function isCommandValue(toolName: string, key: string | undefined): boolean {
  return COMMAND_TOOL.test(toolName) || (key !== undefined && COMMAND_KEY.test(key));
}

const MAX_DEPTH = 32;

/**
 * Whether any string value of an input object (keys are not values) is excluded. An input nested
 * deeper than any tool schema needs is not walked to the end: it counts as excluded.
 */
export function inputExcluded(
  input: unknown,
  isExcludedValue: (value: string, key: string | undefined) => boolean,
  depth = 0,
  key?: string,
): boolean {
  if (depth > MAX_DEPTH) return true;
  if (typeof input === 'string') return isExcludedValue(input, key);
  if (Array.isArray(input)) {
    return input.some((item) => inputExcluded(item, isExcludedValue, depth + 1, key));
  }
  if (typeof input === 'object' && input !== null) {
    return Object.entries(input).some(([k, v]) => inputExcluded(v, isExcludedValue, depth + 1, k));
  }
  return false;
}

/**
 * The input with every string value passed through `redact` (the content net), keys and other
 * values unchanged: for rendering an earlier tool call (inspection P4T-I001).
 */
export function mapInputStrings(
  input: unknown,
  redact: (text: string) => string,
  depth = 0,
): unknown {
  if (depth > MAX_DEPTH) return undefined;
  if (typeof input === 'string') return redact(input);
  if (Array.isArray(input)) return input.map((item) => mapInputStrings(item, redact, depth + 1));
  if (typeof input === 'object' && input !== null) {
    return Object.fromEntries(
      Object.entries(input).map(([k, v]) => [k, mapInputStrings(v, redact, depth + 1)]),
    );
  }
  return input;
}
