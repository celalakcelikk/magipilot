import { describe, expect, it } from 'vitest';
import { extractCursorContext, lineBeforeCursor } from '../../src/core/context/cursor';
import { globToRegExp, isExcluded } from '../../src/core/context/exclude';
import { selectSnippets } from '../../src/core/context/snippets';
import { completionUserPrompt } from '../../src/core/prompt/templates';
import { completionUserPrompt as faz0Prompt } from '../../scripts/bench/prompt';
import { loadSamples } from '../../scripts/bench/samples';

const DEFAULT_EXCLUDE = ['.env*', '*.pem', 'secrets/**'];

describe('exclude globs (D10, AGENTS rule 6)', () => {
  const excluded = [
    '.env',
    '.env.local',
    'a/b/.env.prod',
    'x.pem',
    'certs/server.pem',
    'secrets/a',
    'secrets/a/b/c.txt',
    'project/secrets/token.json',
    '/Users/someone/outside/secrets/key.txt',
    'C:\\work\\.env',
  ];
  const allowed = [
    'src/env.ts',
    'environment.ts',
    'my.env.example.md',
    'pem.ts',
    'secretsx/a',
    'docs/secrets.md',
  ];

  for (const path of excluded) {
    it(`excludes ${path}`, () => expect(isExcluded(path, DEFAULT_EXCLUDE)).toBe(true));
  }
  for (const path of allowed) {
    it(`allows ${path}`, () => expect(isExcluded(path, DEFAULT_EXCLUDE)).toBe(false));
  }

  it('supports ?, ** and braces', () => {
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
    expect(globToRegExp('a?.ts').test('a/.ts')).toBe(false);
    expect(isExcluded('src/deep/x.key', ['**/*.{key,pem}'])).toBe(true);
    expect(isExcluded('x.crt', ['*.{key,pem}'])).toBe(false);
    expect(globToRegExp('src/**/*.ts').test('src/a/b/c.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/c.ts')).toBe(true);
  });

  it('ignores empty patterns', () => {
    expect(isExcluded('a.ts', ['', '  '])).toBe(false);
  });
});

describe('cursor context', () => {
  it('returns everything within the limits', () => {
    expect(extractCursorContext('abc|def'.replace('|', ''), 3, 100, 100)).toEqual({
      prefix: 'abc',
      suffix: 'def',
    });
  });

  it('cuts the prefix at a line boundary when the limit falls inside a line', () => {
    const text = 'line one\nline two\nline three';
    const { prefix } = extractCursorContext(text, text.length, 14, 10);
    expect(prefix).toBe('line three');
  });

  it('keeps raw characters when a single line is longer than the limit', () => {
    const text = 'x'.repeat(50);
    expect(extractCursorContext(text, 50, 10, 10).prefix).toBe('x'.repeat(10));
  });

  it('cuts the suffix at a line boundary', () => {
    const text = 'a\nbb\nccc\ndddd';
    expect(extractCursorContext(text, 0, 10, 6).suffix).toBe('a\nbb');
  });

  it('reports the text before the cursor on its line', () => {
    expect(lineBeforeCursor('a\n    return ')).toBe('    return ');
    expect(lineBeforeCursor('top')).toBe('top');
  });
});

describe('snippets', () => {
  const prefix =
    'function totalsByCustomer(orders) {\n  const grouped = groupBy(orders, (o) => o.customerId);\n';
  const related = {
    path: 'src/groupBy.ts',
    text: 'export function groupBy(items, keyOf) {\n  return items.reduce((groups, item) => groups, {});\n}',
  };
  const unrelated = { path: 'src/zzz.ts', text: 'const width = 3;\nconst height = 4;' };

  it('ranks similar code first and drops unrelated documents', () => {
    const snippets = selectSnippets(prefix, [unrelated, related]);
    expect(snippets.map((s) => s.path)).toEqual(['src/groupBy.ts']);
  });

  it('never returns an excluded document (AGENTS rule 6)', () => {
    const secret = { path: 'config/.env', text: related.text };
    expect(selectSnippets(prefix, [secret], { exclude: DEFAULT_EXCLUDE })).toEqual([]);
  });

  it('limits count and size', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({
      path: `src/g${i}.ts`,
      text: related.text.repeat(20),
    }));
    const snippets = selectSnippets(prefix, many, { maxSnippets: 2, maxChars: 50 });
    expect(snippets).toHaveLength(2);
    expect(snippets.every((s) => s.text.length <= 50)).toBe(true);
  });
});

describe('completion prompt template', () => {
  it('is byte-identical to the Faz 0 bench prompt when there are no snippets', () => {
    for (const sample of loadSamples()) {
      expect(completionUserPrompt({ ...sample, snippets: [] })).toBe(faz0Prompt(sample));
    }
  });

  it('adds snippets as reference before the file', () => {
    const prompt = completionUserPrompt({
      prefix: 'a',
      suffix: 'b',
      languageId: 'typescript',
      filePath: 'src/x.ts',
      snippets: [{ path: 'src/y.ts', text: 'export const y = 1;' }],
    });
    expect(prompt).toContain('--- src/y.ts\nexport const y = 1;\n---');
    expect(prompt.endsWith('a<CURSOR>b')).toBe(true);
  });
});
