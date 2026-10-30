import { describe, expect, it } from 'vitest';
import { CompletionCache, type CacheQuery } from '../../src/core/cache';

const URI = 'file:///w/src/a.ts';
const BEFORE = 'function add(a: number, b: number) {\n  return ';
const AFTER = '\n}\n';
const COMPLETION = 'a + b;';

function query(text: string, cursor: number, overrides: Partial<CacheQuery> = {}): CacheQuery {
  return {
    documentUri: URI,
    documentText: text,
    cursorOffset: cursor,
    backendGeneration: 1,
    suffixChars: 1000,
    ...overrides,
  };
}

function look(cache: CompletionCache, q: CacheQuery): string | undefined {
  return cache.lookup(q)?.text;
}

function stored(): CompletionCache {
  const cache = new CompletionCache(100);
  cache.store(query(BEFORE + AFTER, BEFORE.length), COMPLETION, 'claude-cli');
  return cache;
}

describe('CompletionCache', () => {
  it('returns the completion at the same anchor', () => {
    expect(look(stored(), query(BEFORE + AFTER, BEFORE.length))).toBe(COMPLETION);
  });

  it('continues while the user types the completion (typing through)', () => {
    const text = `${BEFORE}a + ${AFTER}`;
    expect(look(stored(), query(text, BEFORE.length + 4))).toBe('b;');
  });

  it('misses once the whole completion has been typed', () => {
    const text = `${BEFORE}${COMPLETION}${AFTER}`;
    expect(look(stored(), query(text, BEFORE.length + COMPLETION.length))).toBeUndefined();
  });

  it('misses when the typed text diverges from the completion', () => {
    const text = `${BEFORE}a - ${AFTER}`;
    expect(look(stored(), query(text, BEFORE.length + 4))).toBeUndefined();
  });

  it('never serves another document with an identical prefix (P1-R003)', () => {
    expect(
      look(stored(), query(BEFORE + AFTER, BEFORE.length, { documentUri: 'file:///w/src/b.ts' })),
    ).toBeUndefined();
  });

  it('misses after a backend/model/settings change (P1-R003)', () => {
    expect(
      look(stored(), query(BEFORE + AFTER, BEFORE.length, { backendGeneration: 2 })),
    ).toBeUndefined();
  });

  it('misses when the suffix changed (P1-R003)', () => {
    const text = `${BEFORE}\n  // edited\n}\n`;
    expect(look(stored(), query(text, BEFORE.length))).toBeUndefined();
  });

  it('misses when text before the anchor was edited', () => {
    const edited = BEFORE.replace('add', 'sum');
    expect(look(stored(), query(edited + AFTER, edited.length))).toBeUndefined();
  });

  describe('exact suffix equality (P1-R006)', () => {
    it('an empty suffix at EOF that becomes non-empty misses — exact hit', () => {
      const cache = new CompletionCache(100);
      cache.store(query(BEFORE, BEFORE.length), COMPLETION, 'claude-cli');
      expect(look(cache, query(`${BEFORE}\npasted();`, BEFORE.length))).toBeUndefined();
    });

    it('an empty suffix at EOF that becomes non-empty misses — continuation', () => {
      const cache = new CompletionCache(100);
      cache.store(query(BEFORE, BEFORE.length), COMPLETION, 'claude-cli');
      const text = `${BEFORE}a + \npasted();`;
      expect(look(cache, query(text, BEFORE.length + 4))).toBeUndefined();
    });

    it('a short suffix that gains appended text misses — exact and continuation', () => {
      const cache = new CompletionCache(100);
      cache.store(query(`${BEFORE}\n}`, BEFORE.length), COMPLETION, 'claude-cli');
      expect(look(cache, query(`${BEFORE}\n}\nmore();`, BEFORE.length))).toBeUndefined();
      expect(look(cache, query(`${BEFORE}a + \n}\nmore();`, BEFORE.length + 4))).toBeUndefined();
      // control: unchanged short suffix still hits
      expect(look(cache, query(`${BEFORE}a + \n}`, BEFORE.length + 4))).toBe('b;');
    });
  });

  describe('configured suffix window (inspection P1-I005)', () => {
    const after = `\n${'x'.repeat(1400)}\nstill inside a 2000-char window\n}\n`;

    it('an edit beyond 1000 chars but inside a 2000-char window misses', () => {
      const cache = new CompletionCache(100);
      cache.store(
        query(BEFORE + after, BEFORE.length, { suffixChars: 2000 }),
        COMPLETION,
        'claude-cli',
      );
      const edited = BEFORE + after.replace('still inside', 'edited inside');
      expect(look(cache, query(edited, BEFORE.length, { suffixChars: 2000 }))).toBeUndefined();
      // control: unchanged text still hits with the same window
      expect(look(cache, query(BEFORE + after, BEFORE.length, { suffixChars: 2000 }))).toBe(
        COMPLETION,
      );
    });

    it('an entry built with another suffix window never hits', () => {
      const cache = new CompletionCache(100);
      cache.store(
        query(BEFORE + AFTER, BEFORE.length, { suffixChars: 2000 }),
        COMPLETION,
        'claude-cli',
      );
      expect(
        look(cache, query(BEFORE + AFTER, BEFORE.length, { suffixChars: 1000 })),
      ).toBeUndefined();
    });
  });

  describe('long lines beyond maxPrefixChars (P1-R005)', () => {
    const longLine = `const s = "${'x'.repeat(5000)}" + `;

    it('continues on a single line longer than the prefix limit', () => {
      const cache = new CompletionCache(100);
      cache.store(query(longLine, longLine.length), 'tail();', 'claude-cli');
      expect(look(cache, query(`${longLine}ta`, longLine.length + 2))).toBe('il();');
    });

    it('continues right at the limit', () => {
      const atLimit = 'y'.repeat(2998) + ' = ';
      const cache = new CompletionCache(100);
      cache.store(query(atLimit, atLimit.length), '42;', 'claude-cli');
      expect(look(cache, query(`${atLimit}4`, atLimit.length + 1))).toBe('2;');
    });
  });

  it('returns the producing backend with exact and continuation hits (P1-I012)', () => {
    const cache = new CompletionCache(100);
    cache.store(query(BEFORE + AFTER, BEFORE.length), COMPLETION, 'codex-cli');
    expect(cache.lookup(query(BEFORE + AFTER, BEFORE.length))).toMatchObject({
      text: COMPLETION,
      backend: 'codex-cli',
      dependencies: [],
    });
    expect(cache.lookup(query(`${BEFORE}a + ${AFTER}`, BEFORE.length + 4))).toMatchObject({
      text: 'b;',
      backend: 'codex-cli',
      dependencies: [],
    });
  });

  it('keeps the dependency states of an entry and drops entries on request (phase-3-context AC3b)', () => {
    const cache = new CompletionCache(100);
    const dependency = {
      kind: 'file' as const,
      path: '/w/src/d.ts',
      realPath: '/w/src/d.ts',
      size: 10,
      mtimeMs: 1,
    };
    cache.store(query(BEFORE + AFTER, BEFORE.length), COMPLETION, 'claude-cli', [dependency]);
    cache.store(query('other', 5), ' text', 'claude-cli');
    const hit = cache.lookup(query(BEFORE + AFTER, BEFORE.length));
    expect(hit?.dependencies).toEqual([dependency]);
    cache.drop(hit!);
    expect(cache.lookup(query(BEFORE + AFTER, BEFORE.length))).toBeUndefined();
    expect(cache.lookup(query('other', 5))).toBeDefined();
  });

  it('dropWithDependencies() removes only entries made with signatures', () => {
    const cache = new CompletionCache(100);
    const dependency = {
      kind: 'document' as const,
      path: '/w/d.ts',
      realPath: '/w/d.ts',
      uri: 'file:///w/d.ts',
      version: 3,
    };
    cache.store(query(BEFORE + AFTER, BEFORE.length), COMPLETION, 'claude-cli', [dependency]);
    cache.store(query('other', 5), ' text', 'claude-cli');
    cache.dropWithDependencies();
    expect(cache.lookup(query(BEFORE + AFTER, BEFORE.length))).toBeUndefined();
    expect(cache.lookup(query('other', 5))).toBeDefined();
    expect(cache.size).toBe(1);
  });

  it('evicts least recently used entries', () => {
    const cache = new CompletionCache(2);
    cache.store(query('a', 1), 'A', 'claude-cli');
    cache.store(query('b', 1), 'B', 'claude-cli');
    expect(look(cache, query('a', 1))).toBe('A'); // touch a
    cache.store(query('c', 1), 'C', 'claude-cli');
    expect(cache.size).toBe(2);
    expect(look(cache, query('b', 1))).toBeUndefined();
    expect(look(cache, query('a', 1))).toBe('A');
  });
});
