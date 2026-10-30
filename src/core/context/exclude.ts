// `magipilot.exclude` glob matching (docs/plans/phase-1.md D10, AGENTS.md rule 6).
// - A pattern without "/" matches the file name at any depth (".env*", "*.pem").
// - A pattern with "/" matches the workspace-relative path ("secrets/**"); it also matches any
//   segment-aligned trailing part of the path, so files outside a workspace folder (absolute
//   paths) are excluded rather than leaked when in doubt.
// - A pattern that ends with "/" names a directory and means "<dir>/**", as in gitignore
//   (docs/plans/phase-2-hardening.md H8c).
// - Supported syntax: "*" (no "/"), "**" (any number of path segments), "?", "{a,b}".
// - Unicode (H8a, H8b): paths and patterns are also compared in NFC and, with `caseInsensitive`
//   (darwin, win32), in their `matchKey` form. Each extra form only adds matches: a path is
//   excluded when any form matches, so stricter options never exclude less.

export interface ExcludeOptions {
  /** Compare NFC → `toLowerCase()` → NFC forms as well (case-insensitive file systems). */
  caseInsensitive?: boolean;
  /**
   * Read "\" as "/" in paths and patterns (the default). On POSIX a "\" is part of a file name,
   * and the content net's discovery cannot read it as "/" (inspection HARD-I002).
   */
  backslashIsSeparator?: boolean;
}

/**
 * The matching options of a platform: case-insensitive on darwin and win32, "\" a separator on
 * win32 only.
 */
export function platformExcludeOptions(
  platform: NodeJS.Platform = process.platform,
): ExcludeOptions {
  return {
    caseInsensitive: platform === 'darwin' || platform === 'win32',
    backslashIsSeparator: platform === 'win32',
  };
}

/**
 * The form `T` in which paths and patterns are compared (H8a): NFC, and NFC → `toLowerCase()` →
 * NFC when case-insensitive. Lowercasing can change the length (U+0130 becomes `i` + U+0307).
 */
export function matchKey(text: string, options: ExcludeOptions = {}): string {
  const nfc = text.normalize('NFC');
  return options.caseInsensitive ? nfc.toLowerCase().normalize('NFC') : nfc;
}

export function globToRegExp(glob: string): RegExp {
  let source = '';
  let i = 0;
  while (i < glob.length) {
    const char = glob[i]!;
    if (char === '*') {
      if (glob[i + 1] === '*') {
        // "**/" → zero or more directories; trailing "**" → anything.
        if (glob[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 3;
        } else {
          source += '.*';
          i += 2;
        }
      } else {
        source += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      source += '[^/]';
      i += 1;
    } else if (char === '{') {
      const close = glob.indexOf('}', i);
      if (close < 0) {
        source += '\\{';
        i += 1;
      } else {
        const options = glob
          .slice(i + 1, close)
          .split(',')
          .map((part) => globToRegExp(part).source.slice(1, -1));
        source += `(?:${options.join('|')})`;
        i = close + 1;
      }
    } else {
      source += char.replace(/[.+^$()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  // `s`: "**" must also cross a U+2028/U+2029 or a CR in a file name (red-team case tags-r1-2).
  return new RegExp(`^${source}$`, 's');
}

// "\" is read as "/" unless `backslashIsSeparator` is false (POSIX, where it is part of a name).
function normalize(path: string, options: ExcludeOptions): string {
  const slashed = options.backslashIsSeparator === false ? path : path.replace(/\\/g, '/');
  return slashed.replace(/^\.\//, '');
}

/**
 * A pattern as the matcher reads it: trimmed, `\` as `/` (see `backslashIsSeparator`), without a
 * leading `./`, and a trailing `/` expanded to `/**` (H8c). A pattern of slashes only names no
 * directory and stays empty.
 */
export function expandPattern(raw: string, options: ExcludeOptions = {}): string {
  const pattern = normalize(raw.trim(), options);
  if (!pattern.endsWith('/')) return pattern;
  const directory = pattern.replace(/\/+$/, '');
  return directory === '' ? '' : `${directory}/**`;
}

/** The forms compared: as written, NFC, and the case-insensitive key when asked for. */
function forms(text: string, options: ExcludeOptions): string[] {
  const all = [text, text.normalize('NFC')];
  if (options.caseInsensitive) all.push(matchKey(text, options));
  return all;
}

function matches(path: string, pattern: string): boolean {
  const segments = path
    .replace(/^\/+/, '')
    .split('/')
    .filter((segment) => segment !== '');
  if (!pattern.includes('/')) return globToRegExp(pattern).test(segments.at(-1) ?? '');
  const regex = globToRegExp(pattern.replace(/^\/+/, ''));
  for (let start = 0; start < segments.length; start++) {
    if (regex.test(segments.slice(start).join('/'))) return true;
  }
  return false;
}

export function isExcluded(
  path: string,
  patterns: readonly string[],
  options: ExcludeOptions = {},
): boolean {
  const paths = forms(normalize(path, options), options);
  for (const raw of patterns) {
    const expanded = expandPattern(raw, options);
    if (expanded === '') continue;
    const keys = forms(expanded, options);
    for (let form = 0; form < keys.length; form++) {
      // Skip a form identical to the previous one (ASCII text, already-NFC text).
      if (form > 0 && keys[form] === keys[form - 1] && paths[form] === paths[form - 1]) continue;
      if (matches(paths[form]!, keys[form]!)) return true;
    }
  }
  return false;
}
