import { describe, expect, it } from 'vitest';
import {
  expandPattern,
  isExcluded,
  matchKey,
  platformExcludeOptions,
} from '../../src/core/context/exclude';

const CI = { caseInsensitive: true };
const NFD_CAFE = 'cafe\u0301';
const NFC_CAFE = 'caf\u00e9';

describe('platformExcludeOptions (H8a)', () => {
  it('is case-insensitive on darwin and win32 only', () => {
    expect(platformExcludeOptions('darwin')).toMatchObject({ caseInsensitive: true });
    expect(platformExcludeOptions('win32')).toMatchObject({ caseInsensitive: true });
    expect(platformExcludeOptions('linux')).toMatchObject({ caseInsensitive: false });
  });

  it('reads "\\" as a separator on win32 only (HARD-I002)', () => {
    expect(platformExcludeOptions('win32').backslashIsSeparator).toBe(true);
    expect(platformExcludeOptions('darwin').backslashIsSeparator).toBe(false);
    expect(platformExcludeOptions('linux').backslashIsSeparator).toBe(false);
  });

  it('on POSIX a "\\" is part of a name, in paths and patterns', () => {
    const posix = { backslashIsSeparator: false };
    expect(isExcluded('a\\secret.txt', ['secret*'], posix)).toBe(false);
    expect(isExcluded('a\\secret.txt', ['a\\secret*'], posix)).toBe(true);
    expect(isExcluded('a\\secret.txt', ['secret*'])).toBe(true);
    expect(expandPattern('private\\', posix)).toBe('private\\');
  });

  it('defaults to the running platform', () => {
    expect(platformExcludeOptions()).toEqual(platformExcludeOptions(process.platform));
  });
});

describe('matchKey (H8a, H8b)', () => {
  it('is NFC, and NFC → lower case → NFC when case-insensitive', () => {
    expect(matchKey(NFD_CAFE)).toBe(NFC_CAFE);
    expect(matchKey('\u212Aey')).toBe('Key');
    expect(matchKey('\u212Aey', CI)).toBe('key');
    expect(matchKey('A\u030ABC', CI)).toBe('\u00e5bc');
  });

  it('lets lower-casing change the length (U+0130)', () => {
    expect(matchKey('\u0130', CI)).toBe('i\u0307');
    expect(matchKey('I\u0307', CI)).toBe('i\u0307');
    expect(matchKey('\u0130')).toBe('\u0130');
  });
});

describe('expandPattern (H8c)', () => {
  it('trims, uses "/" and drops a leading "./"', () => {
    expect(expandPattern('  ./a\\b.txt ')).toBe('a/b.txt');
    expect(expandPattern('.env*')).toBe('.env*');
  });

  it('reads a trailing "/" as "/**"', () => {
    expect(expandPattern('private/')).toBe('private/**');
    expect(expandPattern('private\\')).toBe('private/**');
    expect(expandPattern('a/b//')).toBe('a/b/**');
    expect(expandPattern('/private/')).toBe('/private/**');
  });

  it('leaves a pattern of slashes empty', () => {
    expect(expandPattern('/')).toBe('');
    expect(expandPattern(' // ')).toBe('');
    expect(isExcluded('a/b.txt', ['/'])).toBe(false);
  });
});

describe('isExcluded with options', () => {
  it('matches a directory pattern like gitignore', () => {
    for (const path of ['private/key.txt', 'a/private/b/key.txt', '/abs/private/key.txt']) {
      expect(isExcluded(path, ['private/'])).toBe(true);
    }
    for (const path of ['privatex', 'privatex/key.txt', 'private', 'a/private']) {
      expect(isExcluded(path, ['private/'])).toBe(false);
    }
  });

  it('matches case-insensitively only when asked', () => {
    expect(isExcluded('SECRETS/a.txt', ['secrets/**'])).toBe(false);
    expect(isExcluded('SECRETS/a.txt', ['secrets/**'], CI)).toBe(true);
    expect(isExcluded('config/.ENV.local', ['.env*'], CI)).toBe(true);
    expect(isExcluded('Private/Key.TXT', ['private/'], CI)).toBe(true);
  });

  it('compares NFC forms of paths and patterns', () => {
    expect(isExcluded(`${NFD_CAFE}/x.txt`, [`${NFC_CAFE}/**`])).toBe(true);
    expect(isExcluded(`${NFC_CAFE}/x.txt`, [`${NFD_CAFE}/**`])).toBe(true);
    expect(isExcluded(`${NFC_CAFE}/${NFD_CAFE}/x`, [`${NFD_CAFE}/${NFC_CAFE}/`])).toBe(true);
    expect(isExcluded(`${NFD_CAFE}.txt`, [`${NFC_CAFE}.txt`])).toBe(true);
  });

  it('maps U+212A KELVIN SIGN to K', () => {
    expect(isExcluded('\u212Aey.txt', ['Key.txt'])).toBe(true);
    expect(isExcluded('\u212Aey.txt', ['key.txt'])).toBe(false);
    expect(isExcluded('\u212Aey.txt', ['key.txt'], CI)).toBe(true);
    expect(isExcluded('key.txt', ['\u212Aey.txt'], CI)).toBe(true);
  });

  it('lower-cases U+0130 to i + U+0307 when case-insensitive (HARD-R006)', () => {
    for (const path of ['\u0130.txt', 'I\u0307.txt']) {
      expect(isExcluded(path, ['i*'])).toBe(false);
      expect(isExcluded(path, ['i*'], CI)).toBe(true);
      expect(isExcluded(path, ['i?.txt'], CI)).toBe(true);
    }
  });

  it('never excludes less with stricter options', () => {
    // "?" matches the one character U+0130 as written, but not the two of its lower-case form.
    expect(isExcluded('\u0130.txt', ['?.txt'])).toBe(true);
    expect(isExcluded('\u0130.txt', ['?.txt'], CI)).toBe(true);
    // "e*" matches the NFD spelling as written, but not "é" in NFC.
    expect(isExcluded('éx', ['e*'])).toBe(true);
    expect(isExcluded('éx', ['e*'], CI)).toBe(true);
  });

  it('keeps the old results without options', () => {
    expect(isExcluded('.env', ['.env*'])).toBe(true);
    expect(isExcluded('C:\\work\\.env', ['.env*'])).toBe(true);
    expect(isExcluded('src/env.ts', ['.env*'])).toBe(false);
    expect(isExcluded('docs/secrets.md', ['secrets/**'])).toBe(false);
  });
});
