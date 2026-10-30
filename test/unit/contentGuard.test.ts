import { describe, expect, it } from 'vitest';
import {
  buildExcludedContent,
  decodeText,
  discoverExcluded,
  EMPTY_EXCLUDED_CONTENT,
  INDEX_CAPS,
  indexKey,
  isBinary,
  MAX_CANDIDATES,
  MAX_NAME_HITS,
  MAX_RESOLVED_NAMES,
  MIN_LINE_CHARS,
  nameSearchGlobs,
  planIndexReads,
  redactExcludedLines,
  REMOVED_LINE,
  resolveExcludedNames,
  type NameSearch,
} from '../../src/features/chat/contentGuard';
import { discoveryGlobToRegExp } from '../../src/core/context/discovery';

describe('nameSearchGlobs (follow-up §2, FOLLOWUP-R001)', () => {
  const finds = (name: string, options = {}): boolean =>
    nameSearchGlobs(name, options).some((glob) =>
      discoveryGlobToRegExp(glob).test(`public/${name}`),
    );

  it('finds a literal name with glob characters, "\\", spaces at either end and non-ASCII', () => {
    for (const name of [
      'a[1].bin',
      'x*y?.bin',
      '{a,b}.bin',
      'a,b.bin',
      'a\\b.bin',
      ' certificate.bin',
      'certificate.bin ',
      '\tkey .bin',
      'şifre.p12',
    ]) {
      expect(finds(name), name).toBe(true);
      expect(finds(name, { caseInsensitive: true }), name).toBe(true);
    }
  });

  it('never hands the engines a glob character from the name, nor a space', () => {
    for (const glob of nameSearchGlobs(' a[1]{b,c}\\d .bin')) {
      expect(glob).not.toMatch(/[[\]{}\\ ]/);
    }
  });
});

describe('resolveExcludedNames (follow-up §2, HARD-I013)', () => {
  // A workspace as relative paths; `search` runs the glob over it like findFiles.
  const workspace = (paths: readonly string[], failOn?: string): NameSearch => {
    return (glob, max) => {
      if (failOn !== undefined && glob.includes(failOn)) {
        return Promise.reject(new Error('search failed'));
      }
      const regex = discoveryGlobToRegExp(glob);
      const hits = paths.filter((path) => regex.test(path));
      return Promise.resolve({ paths: hits.slice(0, max), cut: hits.length >= max });
    };
  };
  // The alias public/certificate.bin → secrets/key.bin: the oracle excludes it by its realpath.
  const excludedPaths = new Set(['secrets/key.bin', 'public/certificate.bin', 'b/x.bin']);
  const isExcludedHit = (path: string): boolean => excludedPaths.has(path);
  const files = [
    'secrets/key.bin',
    'public/certificate.bin',
    'public/kept.bin',
    'a/x.bin',
    'b/x.bin',
  ];

  it('names an alias with another name, keeps a name whose files are all kept', async () => {
    const excluded = await resolveExcludedNames(
      ['certificate.bin', 'kept.bin', 'missing.bin'],
      workspace(files),
      isExcludedHit,
    );
    expect([...excluded]).toEqual(['certificate.bin']);
  });

  it('a name shared by a kept and an excluded file is excluded (F2)', async () => {
    expect([...(await resolveExcludedNames(['x.bin'], workspace(files), isExcludedHit))]).toEqual([
      'x.bin',
    ]);
  });

  it('compares names as the matcher does: case-folded only when case-insensitive', async () => {
    const insensitive = await resolveExcludedNames(
      ['Certificate.BIN'],
      workspace(files),
      isExcludedHit,
      { caseInsensitive: true },
    );
    expect([...insensitive]).toEqual(['certificate.bin']);
    const sensitive = await resolveExcludedNames(
      ['Certificate.BIN'],
      workspace(files),
      isExcludedHit,
    );
    expect([...sensitive]).toEqual([]);
  });

  it('a search at its bound, or a failed search, makes the name excluded (fail-closed)', async () => {
    const crowd = Array.from({ length: MAX_NAME_HITS }, (_, n) => `d${n}/same.bin`);
    expect([...(await resolveExcludedNames(['same.bin'], workspace(crowd), () => false))]).toEqual([
      'same.bin',
    ]);
    const failing = workspace(files, 'kept');
    expect([...(await resolveExcludedNames(['kept.bin'], failing, isExcludedHit))]).toEqual([
      'kept.bin',
    ]);
  });

  it(`names beyond the first ${MAX_RESOLVED_NAMES} are excluded without a search (FOLLOWUP-R003)`, async () => {
    const kept = Array.from({ length: MAX_RESOLVED_NAMES }, (_, n) => `k${n}.bin`);
    const searched: string[] = [];
    const search: NameSearch = (glob, max) => {
      searched.push(glob);
      return workspace([...files, ...kept.map((name) => `public/${name}`)])(glob, max);
    };
    // Duplicates (also by case) count once, so the alias is the 33rd distinct name.
    const names = [...kept, 'K0.bin', 'certificate.bin'];
    const excluded = await resolveExcludedNames(names, search, isExcludedHit, {
      caseInsensitive: true,
    });
    expect([...excluded]).toEqual(['certificate.bin']);
    expect(searched.some((glob) => glob.includes('ertificate'))).toBe(false);
  });
});

describe('discoverExcluded (HARD-I003)', () => {
  // A search like findFiles: the candidates in its own order, at most `max` of them.
  const search =
    (candidates: readonly string[]) =>
    (max: number): Promise<string[]> =>
      Promise.resolve(candidates.slice(0, max));
  const crowd = Array.from({ length: 1_500 }, (_, n) => `crowd/n${n}.txt`);

  it('false positives never crowd out an excluded file: the file caps come after the filter', async () => {
    const { found, cut } = await discoverExcluded(
      [search([...crowd, 'crowd/item-secret.txt'])],
      (path) => path.endsWith('item-secret.txt'),
    );
    expect(found).toEqual(['crowd/item-secret.txt']);
    expect(cut).toBe(false);
    expect(MAX_CANDIDATES).toBeGreaterThan(INDEX_CAPS.maxFiles * 10);
  });

  it('reports a search that reached the candidate bound', async () => {
    const result = await discoverExcluded(
      [search(crowd), search(['a/item-secret.txt'])],
      (path) => path.includes('secret'),
      1_000,
    );
    expect(result).toEqual({ found: ['a/item-secret.txt'], cut: true });
  });
});

// An excluded workspace file: two indexable lines, a short line and a punctuation-only line.
const EXCLUDED_TEXT = [
  'API_TOKEN=tok_live_4f9a2c',
  '  const password = "hunter22";',
  'x = 1',
  '});});});',
  '',
].join('\n');
const CONTENT = buildExcludedContent([{ path: '/ws/secrets/app.conf', text: EXCLUDED_TEXT }]);

const count = (text: string, part: string): number => text.split(part).length - 1;

describe('isBinary (plan §3)', () => {
  it('finds a NUL byte in the first 8 KiB', () => {
    const head = new Uint8Array(100).fill(65);
    head[10] = 0;
    expect(isBinary(head)).toBe(true);
  });

  it('treats text without NUL as text', () => {
    expect(isBinary(new TextEncoder().encode('const a = 1;\n'))).toBe(false);
    expect(isBinary(new Uint8Array(0))).toBe(false);
  });

  it('looks at the first 8 KiB only', () => {
    const late = new Uint8Array(10_000).fill(65);
    late[9000] = 0;
    expect(isBinary(late)).toBe(false);
    const edge = new Uint8Array(10_000).fill(65);
    edge[8191] = 0;
    expect(isBinary(edge)).toBe(true);
    edge[8191] = 65;
    edge[8192] = 0;
    expect(isBinary(edge)).toBe(false);
  });
});

describe('decodeText', () => {
  const SECRET_TEXT = 'DB_PASSWORD=s3cr3t_value_1\r\nAPI_KEY=ak_live_abcdef123456\r\n';
  const utf16le = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'utf16le'));
  const utf16be = (text: string): Uint8Array =>
    new Uint8Array(Buffer.from(text, 'utf16le').swap16());

  it('decodes UTF-8 text and drops its byte order mark', () => {
    expect(decodeText(new TextEncoder().encode('şifre = 1\n'))).toBe('şifre = 1\n');
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x62]))).toBe('ab');
    expect(decodeText(new Uint8Array(0))).toBe('');
  });

  it('leaves a binary file undecoded', () => {
    expect(decodeText(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]))).toBeUndefined();
  });

  it('decodes UTF-16 with a byte order mark although its bytes contain NUL', () => {
    // Windows PowerShell 5.1 `>` and Out-File, and .reg exports, write UTF-16LE with a BOM.
    const le = utf16le(`\uFEFF${SECRET_TEXT}`);
    expect(isBinary(le)).toBe(true);
    expect(decodeText(le)).toBe(SECRET_TEXT);
    const be = utf16be(`\uFEFF${SECRET_TEXT}`);
    expect(isBinary(be)).toBe(true);
    expect(decodeText(be)).toBe(SECRET_TEXT);
  });

  it('decodes a partial UTF-16 read up to the cut', () => {
    const le = utf16le(`\uFEFF${SECRET_TEXT}`);
    const text = decodeText(le.subarray(0, le.length - 1));
    expect(text?.startsWith(SECRET_TEXT.slice(0, -1))).toBe(true);
    const be = utf16be(`\uFEFF${SECRET_TEXT}`);
    expect(decodeText(be.subarray(0, be.length - 1))?.startsWith(SECRET_TEXT.slice(0, -1))).toBe(
      true,
    );
  });

  it('lets the net remove the lines of a UTF-16 file', () => {
    const text = decodeText(utf16le(`\uFEFF${SECRET_TEXT}`));
    const content = buildExcludedContent([{ path: '/ws/secrets/creds.txt', text }]);
    const prompt = 'This code at line 1\n```\nDB_PASSWORD=s3cr3t_value_1\n```';
    expect(redactExcludedLines(prompt, content)).toEqual({
      text: `This code at line 1\n\`\`\`\n${REMOVED_LINE}\n\`\`\``,
      removed: 1,
    });
  });
});

describe('indexKey (plan §3 normalisation)', () => {
  it('needs 8 visible characters', () => {
    expect(MIN_LINE_CHARS).toBe(8);
    expect(indexKey('abcdefg')).toBeUndefined();
    expect(indexKey('abcdefgh')).toBe('abcdefgh');
  });

  it('counts non-whitespace characters, not the length', () => {
    expect(indexKey('a b c d e f g')).toBeUndefined();
    expect(indexKey('a b c d e f g h')).toBe('a b c d e f g h');
    expect(indexKey('\t   abcdefg   \t')).toBeUndefined();
  });

  it('counts code points, not UTF-16 units', () => {
    const emoji = '\u{1F600}'.repeat(4);
    expect(indexKey(`${emoji}abc`)).toBeUndefined();
    expect(indexKey(`${emoji}abcd`)).toBe(`${emoji}abcd`);
  });

  it('needs a letter or a digit', () => {
    expect(indexKey('});});});')).toBeUndefined();
    expect(indexKey('==========')).toBeUndefined();
    expect(indexKey('-----------')).toBeUndefined();
    expect(indexKey('12345678')).toBe('12345678');
    expect(indexKey('şifre=çok_gizli')).toBe('şifre=çok_gizli');
  });

  it('trims the line and drops a trailing CR', () => {
    expect(indexKey('  value = 42;\r')).toBe('value = 42;');
    expect(indexKey('\tvalue = 42;  ')).toBe('value = 42;');
  });

  it('skips empty and blank lines', () => {
    expect(indexKey('')).toBeUndefined();
    expect(indexKey('   \t ')).toBeUndefined();
    expect(indexKey('\r')).toBeUndefined();
  });
});

describe('buildExcludedContent', () => {
  it('indexes the long lines of a text file and its basename', () => {
    expect([...CONTENT.lines].sort()).toEqual([
      'API_TOKEN=tok_live_4f9a2c',
      'const password = "hunter22";',
    ]);
    expect([...CONTENT.names]).toEqual(['app.conf']);
  });

  it('splits CRLF files without keeping the CR', () => {
    const content = buildExcludedContent([
      { path: 'secrets/crlf.txt', text: 'first_line = 1\r\nsecond_line = 2\r\n' },
    ]);
    expect([...content.lines].sort()).toEqual(['first_line = 1', 'second_line = 2']);
    expect([...content.lines].some((line) => line.includes('\r'))).toBe(false);
  });

  it('splits at a lone CR as well, as VS Code and Copilot do', () => {
    const lone = buildExcludedContent([
      { path: 'secrets/legacy.cfg', text: 'first_line = 1\rsecond_line = 2\r' },
    ]);
    expect([...lone.lines].sort()).toEqual(['first_line = 1', 'second_line = 2']);
    const mixed = buildExcludedContent([
      { path: 'secrets/mixed.cfg', text: 'first_line = 1\rsecond_line = 2\r\nthird_line = 3\n' },
    ]);
    expect([...mixed.lines].sort()).toEqual([
      'first_line = 1',
      'second_line = 2',
      'third_line = 3',
    ]);
  });

  it('takes only the basename of a binary file, with "\\" read both ways (HARD-I007)', () => {
    const content = buildExcludedContent([
      { path: '/ws/secrets/key.bin' },
      { path: 'C:\\ws\\certs\\server.p12' },
      { path: '/ws/secrets/a\\b.p12' },
      { path: 'secrets/notes.txt', text: '' },
    ]);
    expect(content.lines.size).toBe(0);
    // A "\" is a separator on Windows and part of the name on POSIX.
    expect([...content.names].sort()).toEqual([
      'C:\\ws\\certs\\server.p12',
      'a\\b.p12',
      'b.p12',
      'key.bin',
      'notes.txt',
      'server.p12',
    ]);
  });

  it('returns empty sets for no files', () => {
    const content = buildExcludedContent([]);
    expect(content.lines.size).toBe(0);
    expect(content.names.size).toBe(0);
  });
});

describe('planIndexReads (plan §3 caps, AC5)', () => {
  const caps = { maxFiles: 10, maxFileBytes: 100, maxTotalBytes: 1000 };

  it('reads every file whole in path order when the caps allow it', () => {
    const files = [
      { path: 'b.txt', size: 10 },
      { path: 'B.txt', size: 20 },
      { path: 'a.txt', size: 30 },
    ];
    const before = files.map((file) => file.path);
    expect(planIndexReads(files, caps)).toEqual({
      reads: [
        { path: 'B.txt', bytes: 20 },
        { path: 'a.txt', bytes: 30 },
        { path: 'b.txt', bytes: 10 },
      ],
      truncated: false,
    });
    expect(files.map((file) => file.path)).toEqual(before);
  });

  it('stops at the file count cap', () => {
    const files = ['c', 'a', 'b'].map((path) => ({ path, size: 1 }));
    const plan = planIndexReads(files, { ...caps, maxFiles: 2 });
    expect(plan.reads.map((read) => read.path)).toEqual(['a', 'b']);
    expect(plan.truncated).toBe(true);
    expect(planIndexReads(files, { ...caps, maxFiles: 0 })).toEqual({
      reads: [],
      truncated: true,
    });
  });

  it('reads a large file partially', () => {
    const plan = planIndexReads(
      [
        { path: 'a', size: 50 },
        { path: 'b', size: 150 },
      ],
      caps,
    );
    expect(plan.reads).toEqual([
      { path: 'a', bytes: 50 },
      { path: 'b', bytes: 100 },
    ]);
    expect(plan.truncated).toBe(true);
  });

  it('shares the total budget between the files', () => {
    const files = ['a', 'b', 'c', 'd'].map((path) => ({ path, size: 50 }));
    const plan = planIndexReads(files, { ...caps, maxTotalBytes: 120 });
    expect(plan.reads).toEqual([
      { path: 'a', bytes: 30 },
      { path: 'b', bytes: 30 },
      { path: 'c', bytes: 30 },
      { path: 'd', bytes: 30 },
    ]);
    expect(plan.truncated).toBe(true);
  });

  it('gives the rest of the budget to the files in path order', () => {
    const files = [
      { path: 'a', size: 50 },
      { path: 'b', size: 50 },
      { path: 'c', size: 1 },
    ];
    // Share 33 each; c needs 1, so 33 bytes are left: 17 complete a, 16 go to b.
    expect(planIndexReads(files, { ...caps, maxTotalBytes: 100 })).toEqual({
      reads: [
        { path: 'a', bytes: 50 },
        { path: 'b', bytes: 49 },
        { path: 'c', bytes: 1 },
      ],
      truncated: true,
    });
  });

  it('is not truncated when every file fits the budget exactly', () => {
    const exact = [
      { path: 'a', size: 50 },
      { path: 'b', size: 50 },
    ];
    expect(planIndexReads(exact, { ...caps, maxTotalBytes: 100 }).truncated).toBe(false);
    // An empty file needs no budget: a and b still get their 50 bytes.
    expect(
      planIndexReads([...exact, { path: 'c', size: 0 }], { ...caps, maxTotalBytes: 100 }),
    ).toEqual({
      reads: [
        { path: 'a', bytes: 50 },
        { path: 'b', bytes: 50 },
        { path: 'c', bytes: 0 },
      ],
      truncated: false,
    });
  });

  it('reads a small file whole behind large or binary files', () => {
    const MiB = 1024 * 1024;
    const files = [
      ...Array.from({ length: 8 }, (_, i) => ({
        path: `/ws/secrets/backup-${i}.tar.gz`,
        size: 50 * MiB,
      })),
      { path: '/ws/secrets/prod.cfg', size: 300 },
    ];
    const plan = planIndexReads(files);
    expect(plan.reads.find((read) => read.path.endsWith('prod.cfg'))).toEqual({
      path: '/ws/secrets/prod.cfg',
      bytes: 300,
    });
    expect(plan.reads).toHaveLength(9);
    expect(plan.reads.every((read) => read.bytes <= INDEX_CAPS.maxFileBytes)).toBe(true);
    expect(plan.reads.reduce((sum, read) => sum + read.bytes, 0)).toBe(INDEX_CAPS.maxTotalBytes);
    expect(plan.truncated).toBe(true);
  });

  it('gives every file at least the 8 KiB binary probe with the default caps', () => {
    const files = Array.from({ length: 1200 }, (_, i) => ({
      path: `f${String(i).padStart(4, '0')}`,
      size: 50 * 1024 * 1024,
    }));
    const plan = planIndexReads(files);
    expect(plan.reads).toHaveLength(INDEX_CAPS.maxFiles);
    expect(Math.min(...plan.reads.map((read) => read.bytes))).toBeGreaterThanOrEqual(8 * 1024);
    expect(plan.reads.reduce((sum, read) => sum + read.bytes, 0)).toBeLessThanOrEqual(
      INDEX_CAPS.maxTotalBytes,
    );
    expect(plan.truncated).toBe(true);
  });

  it('defaults to 1 000 files, 1 MiB per file and 8 MiB in total', () => {
    expect(INDEX_CAPS).toEqual({
      maxFiles: 1000,
      maxFileBytes: 1024 * 1024,
      maxTotalBytes: 8 * 1024 * 1024,
    });
    const many = Array.from({ length: 1001 }, (_, i) => ({
      path: `f${String(i).padStart(4, '0')}`,
      size: 1,
    }));
    const plan = planIndexReads(many);
    expect(plan.reads).toHaveLength(1000);
    expect(plan.truncated).toBe(true);
    expect(planIndexReads([])).toEqual({ reads: [], truncated: false });
  });
});

describe('redactExcludedLines (plan §3 matching, AC3)', () => {
  it('removes a plain line and keeps unrelated lines verbatim', () => {
    const text = ['const a = 1; // KEEP_MARK', 'API_TOKEN=tok_live_4f9a2c', '', '  done'].join(
      '\n',
    );
    expect(redactExcludedLines(text, CONTENT)).toEqual({
      text: ['const a = 1; // KEEP_MARK', REMOVED_LINE, '', '  done'].join('\n'),
      removed: 1,
    });
  });

  it.each([
    ['indented', '    const password = "hunter22";'],
    ['diff +', '+API_TOKEN=tok_live_4f9a2c'],
    ['diff -', '-API_TOKEN=tok_live_4f9a2c'],
    ['diff context', ' API_TOKEN=tok_live_4f9a2c'],
    ['diff + with indentation', '+  const password = "hunter22";'],
    ['combined diff " +"', ' +API_TOKEN=tok_live_4f9a2c'],
    ['combined diff "++"', '++API_TOKEN=tok_live_4f9a2c'],
    ['combined diff "+ "', '+ API_TOKEN=tok_live_4f9a2c'],
    ['combined diff "--"', '--API_TOKEN=tok_live_4f9a2c'],
    ['combined diff "-+"', '-+API_TOKEN=tok_live_4f9a2c'],
    ['combined diff " -"', ' -API_TOKEN=tok_live_4f9a2c'],
    ['line number', ' 12: API_TOKEN=tok_live_4f9a2c'],
    ['line number without indent', '12: const password = "hunter22";'],
    ['line number with indentation', '   7:   const password = "hunter22";'],
  ])('removes the %s form', (_, line) => {
    const text = `before line\n${line}\nafter line`;
    expect(redactExcludedLines(text, CONTENT)).toEqual({
      text: `before line\n${REMOVED_LINE}\nafter line`,
      removed: 1,
    });
  });

  it('keeps short and punctuation-only lines of an excluded file', () => {
    const text = ['x = 1', '+x = 1', ' 3: x = 1', '});});});', '+});});});'].join('\n');
    expect(redactExcludedLines(text, CONTENT)).toEqual({ text, removed: 0 });
  });

  it('applies the 8-character threshold', () => {
    const content = buildExcludedContent([{ path: 'secrets/s.txt', text: 'abcdefg\nabcdefgh\n' }]);
    expect(redactExcludedLines('abcdefg\nabcdefgh', content)).toEqual({
      text: `abcdefg\n${REMOVED_LINE}`,
      removed: 1,
    });
  });

  it('compares whole lines only (documented limit)', () => {
    const text = 'echo API_TOKEN=tok_live_4f9a2c\nAPI_TOKEN=tok_live_4f9a2c # copied';
    expect(redactExcludedLines(text, CONTENT)).toEqual({ text, removed: 0 });
  });

  it('removes the whole line of CRLF prompt text and keeps its line break', () => {
    const text = 'before\r\nAPI_TOKEN=tok_live_4f9a2c\r\nafter\r\n';
    expect(redactExcludedLines(text, CONTENT)).toEqual({
      text: `before\r\n${REMOVED_LINE}\r\nafter\r\n`,
      removed: 1,
    });
  });

  it('splits prompt text at a lone CR as well', () => {
    const text = 'progress 10%\rAPI_TOKEN=tok_live_4f9a2c\rdone\n';
    expect(redactExcludedLines(text, CONTENT)).toEqual({
      text: `progress 10%\r${REMOVED_LINE}\rdone\n`,
      removed: 1,
    });
  });

  it('removes every line of a lone-CR file in the forms Copilot shows it', () => {
    const raw = 'DB_PASSWORD=s3cr3t_value_1\rAPI_KEY=ak_live_abcdef123456\rDEBUG=false\r';
    const content = buildExcludedContent([{ path: '/ws/secrets/legacy.cfg', text: raw }]);
    // VS Code turns a lone CR into the document's EOL; Copilot numbers the lines (` 1: …`).
    const numbered =
      '1: DB_PASSWORD=s3cr3t_value_1\n2: API_KEY=ak_live_abcdef123456\n3: DEBUG=false';
    const result = redactExcludedLines(numbered, content);
    expect(result.removed).toBe(3);
    expect(result.text).not.toMatch(/s3cr3t_value_1|ak_live_abcdef123456/);
    expect(redactExcludedLines(raw, content).removed).toBe(3);
  });

  it('removes both sides of a merge conflict in a combined diff', () => {
    // The conflicted working-tree file and `git diff` output of a real merge.
    const conflicted = [
      'HOST=db.internal.example',
      '<<<<<<< HEAD',
      'DB_PASSWORD=ours_secret_value_7',
      '=======',
      'DB_PASSWORD=theirs_secret_value_9',
      '>>>>>>> other',
      '',
    ].join('\n');
    const content = buildExcludedContent([{ path: '/ws/secrets/app.conf', text: conflicted }]);
    const diff = [
      'diff --cc secrets/app.conf',
      'index 9542fd4,a91d2c8..0000000',
      '--- a/secrets/app.conf',
      '+++ b/secrets/app.conf',
      '@@@ -1,2 -1,2 +1,6 @@@',
      '  HOST=db.internal.example',
      '++<<<<<<< HEAD',
      ' +DB_PASSWORD=ours_secret_value_7',
      '++=======',
      '+ DB_PASSWORD=theirs_secret_value_9',
      '++>>>>>>> other',
      '',
    ].join('\n');
    const result = redactExcludedLines(diff, content);
    expect(result.text).not.toMatch(/ours_secret_value_7|theirs_secret_value_9|db\.internal/);
    expect(result.removed).toBe(5);
    expect(result.text).toContain('+++ b/secrets/app.conf\n@@@ -1,2 -1,2 +1,6 @@@\n');
    expect(result.text).toContain('\n++=======\n');
    // A line the merge resolution adds is shown with `++`.
    const resolved = buildExcludedContent([{ path: 'x', text: 'DB_PASSWORD=merged_value_3\n' }]);
    expect(redactExcludedLines('++DB_PASSWORD=merged_value_3', resolved).removed).toBe(1);
  });

  it('strips at most two diff prefixes', () => {
    const text = '+++API_TOKEN=tok_live_4f9a2c\n++});});});\n+- x = 1';
    expect(redactExcludedLines(text, CONTENT)).toEqual({ text, removed: 0 });
  });

  it('matches lines of a CRLF file in LF prompt text', () => {
    const content = buildExcludedContent([
      { path: 'secrets/crlf.txt', text: 'DB_PASSWORD=crlf_secret_1\r\nDB_USER=admin_user\r\n' },
    ]);
    const result = redactExcludedLines(
      '```\n+DB_PASSWORD=crlf_secret_1\n DB_USER=admin_user\n```',
      content,
    );
    expect(result.text).not.toContain('crlf_secret_1');
    expect(result.text).not.toContain('admin_user');
    expect(result.removed).toBe(2);
  });

  it('counts each removed line', () => {
    const text = [
      'API_TOKEN=tok_live_4f9a2c',
      'keep this line',
      '+API_TOKEN=tok_live_4f9a2c',
      ' 1: const password = "hunter22";',
    ].join('\n');
    const result = redactExcludedLines(text, CONTENT);
    expect(result.removed).toBe(3);
    expect(count(result.text, REMOVED_LINE)).toBe(3);
    expect(result.text).toContain('keep this line');
  });

  it('removes nothing more on a second run', () => {
    const text = ['API_TOKEN=tok_live_4f9a2c', 'keep this line', '-API_TOKEN=tok_live_4f9a2c'].join(
      '\n',
    );
    const first = redactExcludedLines(text, CONTENT);
    expect(first.removed).toBe(2);
    expect(redactExcludedLines(first.text, CONTENT)).toEqual({ text: first.text, removed: 0 });
    // Even when an excluded file contains the replacement line itself.
    const self = buildExcludedContent([{ path: 'secrets/odd.txt', text: REMOVED_LINE }]);
    expect(redactExcludedLines(first.text, self)).toEqual({ text: first.text, removed: 0 });
  });

  it('leaves the text unchanged without excluded lines', () => {
    const text = 'API_TOKEN=tok_live_4f9a2c\nanything else';
    expect(redactExcludedLines(text, EMPTY_EXCLUDED_CONTENT)).toEqual({ text, removed: 0 });
    const namesOnly = buildExcludedContent([{ path: 'secrets/key.bin' }]);
    expect(redactExcludedLines(text, namesOnly)).toEqual({ text, removed: 0 });
  });
});
