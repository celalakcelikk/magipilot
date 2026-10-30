// Content net for chat prompts (docs/plans/phase-2-hardening.md §3, H7; AGENTS.md rule 6).
// vscode-free: the extension reads the excluded workspace files and passes `(path, text)` pairs.
// Lines of excluded workspace files are removed from every turn, whatever format carried them.
// - Text is split into lines at CRLF, LF and a lone CR, as VS Code and Copilot split it.
// - An excluded line is indexed by `indexKey`: trimmed, at least MIN_LINE_CHARS visible
//   (non-whitespace) characters and at least one letter or digit. Shorter lines are too likely to
//   occur in unrelated text and are left to the parser.
// - A prompt line is tested in four forms: as it is, without one or two leading diff prefixes
//   (`+`, `-` or a space; a merge's combined diff has two columns) and without Copilot's
//   line-number prefix (` 12: `).
// - Limit (documented): lines are compared whole. A secret that shares a line with other text is
//   caught by the parser (messages.ts), not by the net. Files outside the workspace are not
//   indexed.

import { discoveryGlobs } from '../../core/context/discovery';
import { matchKey, type ExcludeOptions } from '../../core/context/exclude';

/** Lines shorter than this (after trimming) are not indexed: too likely to occur elsewhere. */
export const MIN_LINE_CHARS = 8;
export const REMOVED_LINE = '[line removed by magipilot.exclude]';

export interface ExcludedContent {
  /** Normalised lines of excluded text files (see indexKey). */
  readonly lines: ReadonlySet<string>;
  /**
   * Basenames of excluded files in their `matchKey` form: NFC, and case-folded when
   * `caseInsensitive` (binary files contribute only this).
   */
  readonly names: ReadonlySet<string>;
  /** Whether `names` are case-folded, as the matcher compares names on darwin and win32. */
  readonly caseInsensitive?: boolean;
  /**
   * Every excluded file's path that discovery found, read or not (never logged): tool inputs with
   * wildcards and directory arguments are matched against them (docs/plans/phase-4-tools.md T8).
   */
  readonly paths?: ReadonlySet<string>;
  /** Whether `paths` holds every excluded file (discovery was not cut at its cap). */
  readonly pathsComplete?: boolean;
}

export const EMPTY_EXCLUDED_CONTENT: ExcludedContent = { lines: new Set(), names: new Set() };

export interface IndexCaps {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

export const INDEX_CAPS: IndexCaps = {
  maxFiles: 1000,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 8 * 1024 * 1024,
};

/**
 * Candidates per discovery search. Discovery overmatches (on macOS the pattern `i*` searches
 * every file), so the file caps apply only after the exact filter; this bound only stops a search
 * that lists most of a large workspace (inspection HARD-I003).
 */
export const MAX_CANDIDATES = 50_000;

/**
 * Runs every discovery search and keeps the candidates the exact matcher excludes. `search`
 * returns at most `max` candidates; `cut` is true when one returned that many, so the result may
 * miss excluded files. The file caps (`planIndexReads`) apply to the result, never to the
 * candidates.
 */
export async function discoverExcluded<C>(
  searches: readonly ((max: number) => PromiseLike<readonly C[]>)[],
  isExcludedCandidate: (candidate: C) => boolean,
  max = MAX_CANDIDATES,
): Promise<{ found: C[]; cut: boolean }> {
  const found: C[] = [];
  let cut = false;
  for (const search of searches) {
    const candidates = await search(max);
    if (candidates.length >= max) cut = true;
    for (const candidate of candidates) if (isExcludedCandidate(candidate)) found.push(candidate);
  }
  return { found, cut };
}

/** How much of a file's start is searched for a NUL byte. */
const BINARY_PROBE_BYTES = 8 * 1024;
const LINE_BREAK = /\r\n|\r|\n/;
const WHITESPACE = /\s/u;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const DIFF_PREFIXES = new Set(['+', '-', ' ']);
// Copilot's numbered code lines, e.g. the ORIGINAL CODE of a commit-message request.
const LINE_NUMBER_PREFIX = /^\s*\d+: /;

/** A file is binary when its first 8 KiB contain a NUL byte (the raw test; see decodeText). */
export function isBinary(head: Uint8Array): boolean {
  return head.subarray(0, BINARY_PROBE_BYTES).includes(0);
}

/** UTF-16BE bytes in UTF-16LE order; an odd last byte stays as it is. */
function swapBytes(bytes: Uint8Array): Uint8Array {
  const swapped = bytes.slice();
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    swapped[i] = bytes[i + 1]!;
    swapped[i + 1] = bytes[i]!;
  }
  return swapped;
}

/**
 * The text of a file's head, or undefined when the file is binary. A head with a UTF-16 byte order
 * mark is decoded as UTF-16 before the NUL test, as VS Code does: the NUL bytes of its ASCII
 * characters would make it binary. Other heads are binary by `isBinary` and UTF-8 otherwise. A
 * byte order mark is dropped, and a code unit cut off by a partial read becomes U+FFFD.
 */
export function decodeText(head: Uint8Array): string | undefined {
  // `utf-16le` is the only UTF-16 label every Node build decodes; big-endian text is swapped.
  const utf16 = new TextDecoder('utf-16le');
  if (head[0] === 0xff && head[1] === 0xfe) return utf16.decode(head.subarray(2));
  if (head[0] === 0xfe && head[1] === 0xff) return utf16.decode(swapBytes(head.subarray(2)));
  if (isBinary(head)) return undefined;
  return new TextDecoder('utf-8').decode(head);
}

/** Whether `text` has at least `min` non-whitespace code points (stops early). */
function hasVisibleChars(text: string, min: number): boolean {
  let count = 0;
  for (const char of text) {
    if (!WHITESPACE.test(char) && ++count >= min) return true;
  }
  return false;
}

/** The set key of an excluded file's line, or undefined when the line is too short to index. */
export function indexKey(line: string): string | undefined {
  const trimmed = line.replace(/\r$/, '').trim();
  if (!hasVisibleChars(trimmed, MIN_LINE_CHARS)) return undefined;
  if (!LETTER_OR_DIGIT.test(trimmed)) return undefined;
  return trimmed;
}

/** The last path segment, for `/` and `\` separators. */
function basename(path: string, separators: RegExp): string {
  return (
    path
      .split(separators)
      .filter((segment) => segment !== '')
      .at(-1) ?? ''
  );
}

/**
 * Builds the sets; a file without text (binary) contributes only its basename. Pass the
 * matcher's options, so that names are compared as the matcher compares them.
 */
export function buildExcludedContent(
  files: readonly { path: string; text?: string }[],
  options: ExcludeOptions = {},
  discovery: { paths: Iterable<string>; complete: boolean } = {
    paths: files.map((file) => file.path),
    complete: true,
  },
): ExcludedContent {
  const lines = new Set<string>();
  const names = new Set<string>();
  const paths = new Set<string>(discovery.paths);
  for (const file of files) {
    paths.add(file.path);
    // `matchKey`, like the lookup: a name on disk may be NFC, NFD or mixed (HARD-I005), and on
    // darwin and win32 a case-only rename keeps it excluded (HARD-I010). On POSIX a "\" is part
    // of a name (`a\b.p12`), on Windows a separator: both readings go in (HARD-I007).
    for (const separators of [/\//, /[/\\]/]) {
      const name = matchKey(basename(file.path, separators), options);
      if (name !== '') names.add(name);
    }
    if (file.text === undefined) continue;
    for (const line of file.text.split(LINE_BREAK)) {
      const key = indexKey(line);
      if (key !== undefined) lines.add(key);
    }
  }
  return {
    lines,
    names,
    caseInsensitive: options.caseInsensitive === true,
    paths,
    pathsComplete: discovery.complete,
  };
}

/**
 * Which files to read and how many bytes of each, within the caps. The first `maxFiles` files in
 * path order are planned. Each first gets an equal share of `maxTotalBytes` (at least 8 KiB with
 * the default caps), so a small file is read whole however many large or binary files sort before
 * it; the rest of the budget then goes to the files in path order, at most `maxFileBytes` each.
 * `truncated` is true when a file was skipped or read partially, so the caller can log it (meta
 * only).
 */
export function planIndexReads(
  files: readonly { path: string; size: number }[],
  caps: IndexCaps = INDEX_CAPS,
): { reads: { path: string; bytes: number }[]; truncated: boolean } {
  // Code-unit order, not localeCompare: the plan must not depend on the host's locale.
  const planned = [...files]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .slice(0, Math.max(0, caps.maxFiles));
  const sizes = planned.map((file) => Math.max(0, file.size));
  const wanted = sizes.map((size) => Math.min(size, caps.maxFileBytes));
  const total = Math.max(0, caps.maxTotalBytes);
  const share = planned.length === 0 ? 0 : Math.floor(total / planned.length);
  const bytes = wanted.map((want) => Math.min(want, share));
  let remaining = total - bytes.reduce((sum, n) => sum + n, 0);
  for (let i = 0; i < bytes.length && remaining > 0; i++) {
    const extra = Math.min(wanted[i]! - bytes[i]!, remaining);
    bytes[i] = bytes[i]! + extra;
    remaining -= extra;
  }
  return {
    reads: planned.map((file, i) => ({ path: file.path, bytes: bytes[i]! })),
    truncated: planned.length < files.length || bytes.some((n, i) => n < sizes[i]!),
  };
}

/**
 * The keys of a prompt line's forms: plain, without one or two diff prefixes (one column per
 * parent, ` +` or `++` in a merge's combined diff) and without a line number.
 */
function promptKeys(line: string): (string | undefined)[] {
  const keys = [indexKey(line)];
  if (DIFF_PREFIXES.has(line.charAt(0))) {
    keys.push(indexKey(line.slice(1)));
    if (DIFF_PREFIXES.has(line.charAt(1))) keys.push(indexKey(line.slice(2)));
  }
  const numbered = LINE_NUMBER_PREFIX.exec(line);
  if (numbered) keys.push(indexKey(line.slice(numbered[0].length)));
  return keys;
}

/** A search tool's line number after a file name: `12:`, `12-` (grep -n, with context). */
const SEARCH_LINE_NUMBER = /^\d+[:-]/;
/** A context line of `grep -n -C`: `path-12-text`. */
const SEARCH_CONTEXT_PREFIX = /^\S+?-\d+-/;
const MAX_SEARCH_PREFIXES = 3;

/**
 * The extra forms of a tool result's line (docs/plans/phase-4-tools.md, inspection round 1 fixes:
 * filtering on the result side): search tools prefix a file's line with its name and number (`./name:3:text`,
 * `name-3-text`), so the rest after each of the first colons, with or without a line number, and
 * after a context prefix, is tested too. A few more set lookups per line; no substring search.
 */
function searchKeys(line: string): (string | undefined)[] {
  const keys: (string | undefined)[] = [];
  let at = -1;
  for (let i = 0; i < MAX_SEARCH_PREFIXES; i++) {
    at = line.indexOf(':', at + 1);
    if (at < 0) break;
    const rest = line.slice(at + 1);
    keys.push(indexKey(rest));
    const numbered = SEARCH_LINE_NUMBER.exec(rest);
    if (numbered) keys.push(indexKey(rest.slice(numbered[0].length)));
  }
  const context = SEARCH_CONTEXT_PREFIX.exec(line);
  if (context) keys.push(indexKey(line.slice(context[0].length)));
  return keys;
}

/**
 * Replaces every line of `text` whose normalised form is an excluded line. Lines end at CRLF, LF
 * or a lone CR; the whole line goes and its line break stays. Lines that already are REMOVED_LINE
 * are left alone, so a second pass removes nothing more. With `searchPrefixes` (tool results), a
 * line is also tested without a search tool's file and line-number prefix.
 */
export function redactExcludedLines(
  text: string,
  content: ExcludedContent,
  options: { searchPrefixes?: boolean } = {},
): { text: string; removed: number } {
  if (content.lines.size === 0) return { text, removed: 0 };
  let removed = 0;
  // The capture keeps the line breaks at the odd indexes.
  const parts = text.split(/(\r\n|\r|\n)/);
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i]!;
    if (line === REMOVED_LINE) continue;
    const keys = options.searchPrefixes
      ? [...promptKeys(line), ...searchKeys(line)]
      : promptKeys(line);
    if (!keys.some((key) => key !== undefined && content.lines.has(key))) continue;
    parts[i] = REMOVED_LINE;
    removed += 1;
  }
  return removed === 0 ? { text, removed } : { text: parts.join(''), removed };
}

/** Names of id-only attachments searched per request; the others are treated as excluded. */
export const MAX_RESOLVED_NAMES = 32;
/** Search hits per name and workspace folder; a search that reaches it counts as excluded. */
export const MAX_NAME_HITS = 50;

/** The basename of `path` in both readings of `\` (HARD-I007), in `matchKey` form. */
function basenameKeys(path: string, options: ExcludeOptions): string[] {
  return [/\//, /[/\\]/].map((separators) => matchKey(basename(path, separators), options));
}

/**
 * Search globs that find every file named `name`, a literal name and not a pattern (follow-up
 * §2). Its glob characters, `\` and whitespace become `?`, the matcher's one-character wildcard,
 * so that `expandPattern` neither trims nor splits it (FOLLOWUP-R001); `discoveryGlobs` then makes
 * the glob normalisation- and case-blind.
 */
export function nameSearchGlobs(name: string, options: ExcludeOptions = {}): string[] {
  return discoveryGlobs([name.replace(/[*?[\]{},\\]|\s/g, '?')], options);
}

/** One search: the paths it found (all workspace folders) and whether one reached `max`. */
export type NameSearch = (
  glob: string,
  max: number,
) => PromiseLike<{ paths: readonly string[]; cut: boolean }>;

/**
 * The names (in `matchKey` form) of id-only attachments that must be removed (follow-up §2,
 * HARD-I013): a workspace file with that name is excluded (`isExcludedHit`, which tests the
 * realpath, so a symlink with another name counts), or its search failed or reached its bound.
 * Names are deduplicated by `matchKey`; those beyond the first MAX_RESOLVED_NAMES are not
 * searched and count as excluded (FOLLOWUP-R002, FOLLOWUP-R003).
 */
export async function resolveExcludedNames(
  names: readonly string[],
  search: NameSearch,
  isExcludedHit: (path: string) => boolean,
  options: ExcludeOptions = {},
): Promise<Set<string>> {
  const unique = new Map<string, string>();
  for (const name of names) {
    const key = matchKey(name, options);
    if (key !== '' && !unique.has(key)) unique.set(key, name);
  }
  const excluded = new Set<string>();
  let searched = 0;
  for (const [key, name] of unique) {
    if (searched++ >= MAX_RESOLVED_NAMES) {
      excluded.add(key);
      continue;
    }
    try {
      for (const glob of nameSearchGlobs(name, options)) {
        const { paths, cut } = await search(glob, MAX_NAME_HITS);
        const hit = paths.some(
          (path) => basenameKeys(path, options).includes(key) && isExcludedHit(path),
        );
        if (cut || hit) {
          excluded.add(key);
          break;
        }
      }
    } catch {
      excluded.add(key);
    }
  }
  return excluded;
}
