import { describe, expect, it } from 'vitest';
import {
  discoveryGlobs,
  discoveryGlobToRegExp,
  reachableAscii,
} from '../../src/core/context/discovery';
import { isExcluded, matchKey, type ExcludeOptions } from '../../src/core/context/exclude';

const CS: ExcludeOptions = { caseInsensitive: false };
const CI: ExcludeOptions = { caseInsensitive: true };

const regexes = new Map<string, RegExp>();
function engineMatches(glob: string, path: string): boolean {
  let regex = regexes.get(glob);
  if (regex === undefined) {
    regex = discoveryGlobToRegExp(glob);
    regexes.set(glob, regex);
  }
  return regex.test(path);
}

function found(pattern: string, path: string, options: ExcludeOptions): boolean {
  return discoveryGlobs([pattern], options).some((glob) => engineMatches(glob, path));
}

describe('reachableAscii (HARD-R001, HARD-R006)', () => {
  it('contains the known ASCII results of non-ASCII code points', () => {
    const plain = reachableAscii(CS);
    for (const char of [';', '`', 'K']) expect(plain.has(char)).toBe(true);
    const folded = reachableAscii(CI);
    for (const char of [';', '`', 'k', 'i']) expect(folded.has(char)).toBe(true);
  });

  it('holds ASCII characters only, each reachable from a non-ASCII code point', () => {
    const sources: Record<string, string> = {
      ';': ';',
      '`': '`',
      K: 'K',
      k: 'K',
      i: 'İ',
    };
    for (const options of [CS, CI]) {
      for (const char of reachableAscii(options)) {
        expect(char.charCodeAt(0)).toBeLessThan(0x80);
        if (sources[char] !== undefined) expect(matchKey(sources[char], options)).toContain(char);
      }
    }
  });

  it('is computed once per mode', () => {
    expect(reachableAscii(CS)).toBe(reachableAscii({}));
    expect(reachableAscii(CI)).toBe(reachableAscii({ caseInsensitive: true }));
  });
});

describe('discoveryGlobs (plan §3)', () => {
  it('searches a pattern without "/" at any depth', () => {
    expect(discoveryGlobs(['.env*'], CS)).toEqual(['**/.env*']);
    expect(discoveryGlobs(['.env*'], CI)).toEqual(['**/.[eE][nN][vV]*']);
  });

  it('searches a pattern with "/" at the root and at any depth', () => {
    expect(discoveryGlobs(['secrets/**'], CS)).toEqual(['secrets/**', '**/secrets/**']);
    expect(discoveryGlobs(['/secrets/**'], CS)).toEqual(['secrets/**', '**/secrets/**']);
    expect(discoveryGlobs(['secrets/**'], CI)).toEqual([
      '[sS][eE][cC][rR][eE][tT][sS]/**',
      '**/[sS][eE][cC][rR][eE][tT][sS]/**',
    ]);
  });

  it('expands a trailing "/" (H8c)', () => {
    expect(discoveryGlobs(['private/'], CS)).toEqual(['private/**', '**/private/**']);
    const globs = discoveryGlobs(['private/'], CS);
    expect(globs.some((glob) => engineMatches(glob, 'private/key.txt'))).toBe(true);
    expect(globs.some((glob) => engineMatches(glob, 'privatex/key.txt'))).toBe(false);
  });

  it('turns ASCII characters reachable from non-ASCII into "*", not a one-byte "?"', () => {
    expect(discoveryGlobs(['Key.txt'], CS)).toEqual(['**/*ey.txt']);
    expect(discoveryGlobs(['Key.txt'], CI)).toEqual(['**/*[eE][yY].[tT][xX][tT]']);
    expect(discoveryGlobs(['x;y.txt'], CS)).toEqual(['**/x*y.txt']);
    expect(discoveryGlobs(['a`b.txt'], CS)).toEqual(['**/a*b.txt']);
    // ripgrep missed these with "?": U+212A (3 bytes), U+037E (2 bytes), U+1FEF (3 bytes).
    const cases: [string, string, ExcludeOptions][] = [
      ['Key.txt', 'a/Key.txt', CS],
      ['Key.txt', 'a/Key.txt', CI],
      ['key.txt', 'a/Key.txt', CI],
      ['x;y.txt', 'x;y.txt', CS],
      ['a`b.txt', 'a`b.txt', CS],
      ['a`b.txt', 'a`b.txt', CI],
    ];
    for (const [pattern, path, options] of cases) {
      expect(isExcluded(path, [pattern], options)).toBe(true);
      expect(found(pattern, path, options)).toBe(true);
    }
  });

  it('turns "?" into "*" because lower-casing can change a length (U+0130)', () => {
    expect(discoveryGlobs(['i*'], CS)).toEqual(['**/i*']);
    expect(discoveryGlobs(['i*'], CI)).toEqual(['**/*']);
    expect(discoveryGlobs(['i?.txt'], CS)).toEqual(['**/i*.txt']);
    expect(discoveryGlobs(['i?.txt'], CI)).toEqual(['**/*.[tT][xX][tT]']);
    for (const path of ['İ.txt', 'İ.txt']) {
      expect(isExcluded(path, ['i?.txt'], CI)).toBe(true);
      expect(found('i?.txt', path, CI)).toBe(true);
    }
  });

  it('is blind to NFC, NFD and mixed spellings', () => {
    const nfc = 'café';
    const nfd = 'café';
    for (const pattern of [`${nfc}/${nfc}/**`, `${nfd}/${nfd}/**`, `${nfc}/${nfd}/**`]) {
      expect(discoveryGlobs([pattern], CS)).toEqual(['caf*/caf*/**', '**/caf*/caf*/**']);
      for (const path of [`${nfc}/${nfd}/x`, `${nfd}/${nfd}/x`, `w/${nfd}/${nfc}/x`]) {
        expect(isExcluded(path, [pattern], CS)).toBe(true);
        expect(found(pattern, path, CS)).toBe(true);
      }
    }
    expect(discoveryGlobs([`${nfd}/**`], CI)).toEqual(['[cC][aA][fF]*/**', '**/[cC][aA][fF]*/**']);
  });

  it('splits a "**" inside a segment, which the engines do not let cross "/"', () => {
    // The matcher reads "x/**b" as `x/.*b`; VS Code and ripgrep read it as `x/[^/]*b`.
    expect(isExcluded('x/a/cb', ['x/**b'])).toBe(true);
    expect(engineMatches('x/**b', 'x/a/cb')).toBe(false);
    expect(discoveryGlobs(['x/**b'], CS)).toEqual(['x/*b', 'x/*/**/*b', '**/x/*b', '**/x/*/**/*b']);
    expect(found('x/**b', 'x/a/cb', CS)).toBe(true);
    expect(discoveryGlobs(['a**/b'], CS)).toEqual(['ab', 'a*/**/b', '**/ab', '**/a*/**/b']);
    expect(found('a**/b', 'ab', CS) && found('a**/b', 'ax/y/b', CS)).toBe(true);
  });

  it('keeps "**" inside a name pattern as "*"', () => {
    expect(discoveryGlobs(['a**b'], CS)).toEqual(['**/a*b']);
  });

  it('keeps brace groups and makes literal braces and brackets "?"', () => {
    expect(discoveryGlobs(['*.{key,pem}'], CS)).toEqual(['**/*.{key,pem}']);
    expect(discoveryGlobs(['a{b'], CS)).toEqual(['**/a?b']);
    expect(discoveryGlobs(['{a,{b,c}}'], CS)).toEqual(['**/{a,?b,c}?']);
    expect(discoveryGlobs(['[x].txt'], CS)).toEqual(['**/?x?.txt']);
    expect(discoveryGlobs(['{a,**/b}/c'], CS)).toEqual(['a/c', '**/b/c', '**/a/c']);
  });

  it('on POSIX a "\\" in a pattern becomes "?", never an engine escape (HARD-I002)', () => {
    const posix: ExcludeOptions = { ...CS, backslashIsSeparator: false };
    expect(discoveryGlobs(['a\\secret*'], posix)).toEqual(['**/a?secret*']);
    expect(discoveryGlobs(['a\\b/c'], posix)).toEqual(['a?b/c', '**/a?b/c']);
    // With the default, "\" is a separator before discovery sees it.
    expect(discoveryGlobs(['a\\b'], CS)).toEqual(['a/b', '**/a/b']);
  });

  it('splits a group with an empty choice, which ripgrep drops', () => {
    expect(discoveryGlobs(['.env{,.local}'], CS)).toEqual(['**/.env', '**/.env.local']);
    expect(discoveryGlobs(['{a,}b', '{a,,c}d', 'x{}'], CS)).toEqual([
      '**/ab',
      '**/b',
      '**/ad',
      '**/d',
      '**/cd',
      '**/x',
    ]);
    const cases: [string, string, ExcludeOptions][] = [
      ['.env{,.local}', '.env', CS],
      ['.env{,.local}', 'a/.env.local', CS],
      ['config{,.local}.json', 'config.json', CI],
      ['config{,.local}.json', 'Config.Local.json', CI],
      ['{,a}b', 'b', CS],
    ];
    for (const [pattern, path, options] of cases) {
      expect(isExcluded(path, [pattern], options)).toBe(true);
      expect(found(pattern, path, options)).toBe(true);
      for (const glob of discoveryGlobs([pattern], options)) expect(glob).not.toMatch(/[{,],|,}/);
    }
  });

  it('collapses adjacent wildcards so they never form "**"', () => {
    expect(discoveryGlobs(['*?é'], CS)).toEqual(['**/*']);
    expect(discoveryGlobs(['a/*é*/b'], CS)).toEqual(['a/*/b', '**/a/*/b']);
    expect(discoveryGlobs(['a/***'], CS)).toEqual(['a/**', '**/a/**']);
  });

  it('falls back to every file above the glob cap', () => {
    expect(discoveryGlobs(['a**b**c**d**e**f**g**h/i'], CS)).toEqual(['**']);
  });

  it('skips empty patterns and removes duplicates', () => {
    expect(discoveryGlobs(['', '  ', '/', '.env*', './.env*'], CS)).toEqual(['**/.env*']);
  });

  it('produces ASCII globs only', () => {
    const globs = discoveryGlobs(['İK;`한/å*'], CI);
    for (const glob of globs) expect(/^[\x20-\x7e]*$/.test(glob)).toBe(true);
  });
});

describe('discoveryGlobToRegExp', () => {
  it('reads "**" as a globstar only as a whole segment', () => {
    expect(engineMatches('**/a', 'a')).toBe(true);
    expect(engineMatches('**/a', 'x/y/a')).toBe(true);
    expect(engineMatches('a/**', 'a/b/c')).toBe(true);
    expect(engineMatches('a/**/b', 'a/b')).toBe(true);
    expect(engineMatches('a/**/b', 'a/x/y/b')).toBe(true);
    expect(engineMatches('a**b', 'a/b')).toBe(false);
    expect(engineMatches('a**b', 'axyb')).toBe(true);
  });

  it('reads "*", classes and groups', () => {
    expect(engineMatches('*', 'a/b')).toBe(false);
    expect(engineMatches('*', '\u{1F600}é')).toBe(true);
    expect(engineMatches('[xX]', 'X')).toBe(true);
    expect(engineMatches('[xX]', 'y')).toBe(false);
    expect(engineMatches('{a,b/c}', 'b/c')).toBe(true);
    expect(engineMatches('{a,b/c}', 'b')).toBe(false);
    expect(engineMatches('a+(b).c', 'a+(b).c')).toBe(true);
    expect(engineMatches('a{b', 'a{b')).toBe(true);
  });

  it('reads "?" as one ASCII character, where bytes and UTF-16 code units agree', () => {
    expect(engineMatches('?', 'a')).toBe(true);
    expect(engineMatches('?', '[')).toBe(true);
    expect(engineMatches('?', '/')).toBe(false);
    expect(engineMatches('?', 'ab')).toBe(false);
    // ripgrep needs "??", "???" and "????" for these, VS Code "?", "?" and "??": neither is safe.
    for (const char of ['é', 'K', '\u{1F600}']) {
      for (const glob of ['?', '??', '???', '????']) expect(engineMatches(glob, char)).toBe(false);
    }
  });

  it('drops the empty choices of a group, as ripgrep does', () => {
    expect(engineMatches('{,a}b', 'ab')).toBe(true);
    expect(engineMatches('{,a}b', 'b')).toBe(false);
    expect(engineMatches('{a,}b', 'b')).toBe(false);
    expect(engineMatches('x{}', 'x')).toBe(true);
    expect(engineMatches('x{,}', 'x')).toBe(true);
  });
});

// Property test (plan §3): whenever `isExcluded` excludes a path, some discovery glob, read the
// way VS Code and ripgrep read it, finds the raw path.

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const UNITS = [
  ...'abeikKsxAEIS01.-;`',
  'İ', // İ: lower case is i + U+0307
  'ı', // ı
  'K', // KELVIN SIGN: NFC is K
  'Å', // ANGSTROM SIGN: NFC is Å
  ';', // GREEK QUESTION MARK: NFC is ;
  '`', // GREEK VARIA: NFC is `
  '́',
  '̇',
  'é',
  'É',
  'ş',
  'ğ',
  'Å',
  '한', // Hangul syllable, three jamo in NFD
];

/** Other spellings that NFC or case folding can make equal. */
const RESPELLINGS: Record<string, string[]> = {
  K: ['K'],
  k: ['K'],
  K: ['K', 'k'],
  ';': [';'],
  '`': ['`'],
  i: ['İ'],
  I: ['İ'],
  İ: ['İ', 'i̇'],
  Å: ['Å', 'å'],
  Å: ['Å'],
};

type Piece =
  | { kind: 'unit'; unit: string }
  | { kind: 'one' | 'star' | 'stars' }
  | { kind: 'group'; choices: Piece[][] }
  | { kind: 'raw'; text: string };
type Segment = Piece[] | 'globstar';

/** `extra` adds units, e.g. "\" for POSIX runs where it is part of a name. */
function generator(random: () => number, extra: readonly string[] = []) {
  const pool = [...UNITS, ...extra];
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)]!;
  const chance = (p: number): boolean => random() < p;

  const respell = (unit: string): string =>
    pick([
      unit,
      unit.normalize('NFD'),
      unit.toLowerCase(),
      unit.toUpperCase(),
      ...(RESPELLINGS[unit] ?? []),
    ]);
  const units = (min: number, max: number): string => {
    let text = '';
    const count = min + Math.floor(random() * (max - min + 1));
    for (let i = 0; i < count; i++) text += respell(pick(pool));
    return text;
  };

  const pieces = (count: number, inGroup: boolean): Piece[] => {
    const out: Piece[] = [];
    for (let i = 0; i < count; i++) {
      const roll = random();
      if (roll < 0.55) out.push({ kind: 'unit', unit: pick(UNITS) });
      else if (roll < 0.66) out.push({ kind: 'one' });
      else if (roll < 0.78) out.push({ kind: 'star' });
      else if (roll < 0.86) out.push({ kind: 'stars' });
      else if (roll < 0.94 && !inGroup) {
        const choices = 1 + Math.floor(random() * 3);
        out.push({
          kind: 'group',
          choices: Array.from({ length: choices }, () => pieces(Math.floor(random() * 3), true)),
        });
      } else out.push({ kind: 'raw', text: pick(['{', '}', ',', '[', ']']) });
    }
    return out;
  };

  const writePieces = (list: readonly Piece[]): string =>
    list
      .map((piece) => {
        switch (piece.kind) {
          case 'unit':
            return pick([
              piece.unit,
              piece.unit.normalize('NFD'),
              ...(RESPELLINGS[piece.unit] ?? []),
            ]);
          case 'one':
            return '?';
          case 'star':
            return '*';
          case 'stars':
            return '**';
          case 'group':
            return `{${piece.choices.map(writePieces).join(',')}}`;
          case 'raw':
            return piece.text;
        }
      })
      .join('');

  const derivePieces = (list: readonly Piece[]): string =>
    list
      .map((piece) => {
        switch (piece.kind) {
          case 'unit':
            return respell(piece.unit);
          case 'one':
            return units(1, 1);
          case 'star':
            return units(0, 2);
          case 'stars':
            return chance(0.5) ? `${units(0, 1)}/${units(0, 2)}` : units(0, 2);
          case 'group':
            return derivePieces(pick(piece.choices));
          case 'raw':
            return piece.text;
        }
      })
      .join('');

  const segment = (): string => units(1, 3);
  const segments = (min: number, max: number): string[] =>
    Array.from({ length: min + Math.floor(random() * (max - min + 1)) }, segment);

  return (): { pattern: string; path: string } => {
    const count = chance(0.35) ? 1 : 2 + Math.floor(random() * 2);
    const shape: Segment[] = Array.from({ length: count }, () =>
      count > 1 && chance(0.15) ? 'globstar' : pieces(1 + Math.floor(random() * 4), false),
    );
    const trailingSlash = chance(0.08);
    const prefix = pick(['', '', '', '/', './']);
    const pattern =
      prefix +
      shape.map((part) => (part === 'globstar' ? '**' : writePieces(part))).join('/') +
      (trailingSlash ? '/' : '');
    const derived = chance(0.15)
      ? segments(1, 4)
      : [
          ...segments(0, 2),
          ...shape.flatMap((part) => (part === 'globstar' ? segments(0, 2) : [derivePieces(part)])),
          ...(trailingSlash ? segments(1, 2) : []),
        ];
    return { pattern, path: cleanPath(derived.join('/')) };
  };
}

/** A path as `findFiles` returns it: relative, no empty, "." or ".." segments. */
function cleanPath(path: string): string {
  return path
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.' && segment !== '..')
    .join('/');
}

function missed(pattern: string, path: string, options: ExcludeOptions): boolean {
  return isExcluded(path, [pattern], options) && !found(pattern, path, options);
}

/** Deletes one code point at a time while the pair still fails. */
function shrink(pattern: string, path: string, options: ExcludeOptions) {
  let current = { pattern, path };
  for (let changed = true; changed;) {
    changed = false;
    for (const field of ['pattern', 'path'] as const) {
      const points = [...current[field]];
      for (let i = 0; i < points.length && !changed; i++) {
        const next = { ...current, [field]: points.toSpliced(i, 1).join('') };
        if (next.path === '' || cleanPath(next.path) !== next.path) continue;
        if (missed(next.pattern, next.path, options)) {
          current = next;
          changed = true;
        }
      }
    }
  }
  return current;
}

function show(text: string): string {
  return [...text]
    .map((char) => {
      const code = char.codePointAt(0)!;
      return code < 0x80 ? char : `\\u{${code.toString(16)}}`;
    })
    .join('');
}

describe('discovery is a superset of the matcher (property, plan §3)', () => {
  const PAIRS = 20_000;

  // POSIX: "\" is part of a name (`backslashIsSeparator: false`, inspection HARD-I002).
  for (const [name, options, extra] of [
    ['case-sensitive', CS, []],
    ['case-insensitive', CI, []],
    ['case-sensitive, POSIX names', { ...CS, backslashIsSeparator: false }, ['\\']],
    ['case-insensitive, POSIX names', { ...CI, backslashIsSeparator: false }, ['\\']],
  ] as const) {
    it(`finds every excluded path (${name})`, () => {
      const next = generator(mulberry32(0x5eed), extra);
      let excluded = 0;
      for (let i = 0; i < PAIRS; i++) {
        const { pattern, path } = next();
        if (path === '' || !isExcluded(path, [pattern], options)) continue;
        excluded += 1;
        if (found(pattern, path, options)) continue;
        const small = shrink(pattern, path, options);
        expect.fail(
          `pair ${i}: pattern ${show(small.pattern)} excludes ${show(small.path)}, but no ` +
            `discovery glob finds it: ${JSON.stringify(discoveryGlobs([small.pattern], options))} ` +
            `(original: ${show(pattern)} / ${show(path)})`,
        );
      }
      // The generator derives paths from the patterns, so many pairs are excluded.
      expect(excluded).toBeGreaterThan(PAIRS / 4);
    });
  }
});
