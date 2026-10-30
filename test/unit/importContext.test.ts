import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ImportContext,
  DEFAULT_IMPORT_OPTIONS,
  type FileState,
  type ImportContextInput,
  type ImportFs,
  type OpenDocument,
} from '../../src/core/context/importContext';
import { candidatePaths, parseImports } from '../../src/core/context/imports';
import { extractDeclarations, renderDeclarations } from '../../src/core/context/signatures';
import { maskCode as maskSource } from '../../src/core/context/mask';

/** An in-memory file system with symlinks, open documents and an optional delay. */
class MemFs implements ImportFs {
  files = new Map<string, { text: string; mtimeMs: number }>();
  links = new Map<string, string>();
  open = new Map<string, OpenDocument>();
  reads: string[] = [];
  failRealpath = new Set<string>();
  delayMs = 0;

  constructor(files: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(files)) this.files.set(path, { text, mtimeMs: 1 });
  }

  private async pause(): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  /** Follows symlinks of the path and of its parent directories. */
  private resolve(path: string): string {
    let current = path;
    for (let hops = 0; hops < 10; hops++) {
      let changed = false;
      for (const [link, target] of this.links) {
        if (current === link || current.startsWith(`${link}/`)) {
          current = target + current.slice(link.length);
          changed = true;
        }
      }
      if (!changed) return current;
    }
    throw new Error('ELOOP');
  }

  async realpath(path: string): Promise<string> {
    await this.pause();
    if (this.failRealpath.has(path)) throw new Error('EACCES');
    const real = this.resolve(path);
    const isDir = [...this.files.keys()].some((f) => f.startsWith(`${real}/`));
    if (!this.files.has(real) && !isDir) throw new Error('ENOENT');
    return real;
  }

  async stat(path: string): Promise<FileState> {
    await this.pause();
    const file = this.files.get(this.resolve(path));
    if (!file) throw new Error('ENOENT');
    return { size: Buffer.byteLength(file.text), mtimeMs: file.mtimeMs, isFile: true };
  }

  async readFile(path: string): Promise<string> {
    await this.pause();
    this.reads.push(path);
    const file = this.files.get(this.resolve(path));
    if (!file) throw new Error('ENOENT');
    return file.text;
  }

  openDocument(path: string): OpenDocument | undefined {
    return this.open.get(path);
  }
}

const D_TS =
  'export function add(a: number, b: number): number {\n  return a + b; // BODY\n}\nexport function sub(a: number, b: number): number {\n  return a - b;\n}\n';

function input(text: string, overrides: Partial<ImportContextInput> = {}): ImportContextInput {
  return {
    languageId: 'typescript',
    documentText: text,
    documentPath: '/w/src/c.ts',
    folderPath: '/w',
    exclude: ['.env*', '*.pem', 'secrets/**'],
    excludeOptions: { caseInsensitive: false },
    ...overrides,
  };
}

describe('parseImports', () => {
  it('reads local TS/JS imports with their names, in source order', () => {
    const text = [
      "import a from './a';",
      'import { b, c as d, type E } from "../lib/b.js";',
      "import * as ns from './ns';",
      "import def, { x } from './mixed';",
      "import 'side-effect';",
      "import z from 'react';",
      "const { r1, r2: alias } = require('./req');",
      "const whole = require('./whole');",
      "// import { no } from './commented';",
      "/* import { no2 } from './commented2'; */",
    ].join('\n');
    expect(parseImports(text, 'ts', 20)).toEqual([
      { specifier: './a', wanted: { names: [], default: true } },
      { specifier: '../lib/b.js', wanted: { names: ['b', 'c', 'E'] } },
      { specifier: './ns', wanted: {} },
      { specifier: './mixed', wanted: { names: ['x'], default: true } },
      { specifier: './req', wanted: { names: ['r1', 'r2'] } },
      { specifier: './whole', wanted: {} },
    ]);
  });

  it('reads Python relative and module imports', () => {
    const text = [
      'from .util import add, sub as s',
      'from ..pkg.mod import (',
      '  A,',
      '  B,',
      ')',
      'from . import helpers',
      'import os.path, pkg.tools as t',
      'from .star import *',
      '# from .no import x',
    ].join('\n');
    expect(parseImports(text, 'python', 20)).toEqual([
      { specifier: '.util', wanted: { names: ['add', 'sub'] } },
      { specifier: '..pkg.mod', wanted: { names: ['A', 'B'] } },
      { specifier: '.helpers', wanted: {} },
      { specifier: '.', wanted: { names: ['helpers'] } },
      { specifier: 'os.path', wanted: {} },
      { specifier: 'pkg.tools', wanted: {} },
      { specifier: '.star', wanted: {} },
    ]);
  });

  it('looks at no more than maxImports statements', () => {
    const text = Array.from({ length: 30 }, (_, i) => `import { f${i} } from './m${i}';`).join(
      '\n',
    );
    expect(parseImports(text, 'ts', 20)).toHaveLength(20);
  });
});

describe('candidatePaths', () => {
  it('resolves TS/JS specifiers with extensions, index files and .js → .ts', () => {
    const plain = candidatePaths('ts', './b', 'src');
    expect(plain.slice(0, 3)).toEqual(['src/b.ts', 'src/b.tsx', 'src/b.d.ts']);
    expect(plain).toContain('src/b/index.ts');
    expect(candidatePaths('ts', '../lib/b.js', 'src/x')).toEqual([
      'src/lib/b.ts',
      'src/lib/b.tsx',
      'src/lib/b.js',
    ]);
  });

  it('resolves Python relative and absolute modules', () => {
    expect(candidatePaths('python', '.util', 'pkg')).toEqual([
      'pkg/util.py',
      'pkg/util/__init__.py',
    ]);
    expect(candidatePaths('python', '..pkg.mod', 'a/b')).toEqual([
      'a/pkg/mod.py',
      'a/pkg/mod/__init__.py',
    ]);
    expect(candidatePaths('python', 'pkg.tools', 'app')).toEqual([
      'app/pkg/tools.py',
      'app/pkg/tools/__init__.py',
      'pkg/tools.py',
      'pkg/tools/__init__.py',
    ]);
    expect(candidatePaths('python', '.', 'pkg')).toEqual(['pkg/__init__.py']);
  });

  it('never returns a path that leaves the workspace folder', () => {
    expect(candidatePaths('ts', '../../x', 'src')).toEqual([]);
    expect(candidatePaths('python', '...x', 'a')).toEqual([]);
  });
});

describe('extractDeclarations (TS/JS)', () => {
  const source = [
    '// a { brace in a comment',
    "import { x } from './x';",
    'export interface Point { x: number; y: number }',
    'export type Id = string | number;',
    'export const LIMIT = 10;',
    'export const add = (a: number, b: number): number => a + b;',
    'export const run = async (s: string) => {',
    '  return s;',
    '};',
    'export const conf: Config = { a: 1 };',
    'export function sum(values: number[]): { total: number } {',
    '  const s = "}{";',
    '  return { total: values.length };',
    '}',
    'export async function fetchJson<T>(url: string): Promise<T> {',
    '  return (await fetch(url)).json() as T;',
    '}',
    'export default class Store<T> extends Base<T> {',
    '  private secret = 1;',
    '  #hidden = 2;',
    '  readonly name: string;',
    '  static count = 0;',
    '  constructor(private readonly items: T[]) {',
    '    super();',
    '  }',
    '  get size(): number { return this.items.length; }',
    '  add(item: T): void {',
    '    this.items.push(item);',
    '  }',
    '}',
    'export enum Color { Red, Green }',
    'function local() {}',
  ].join('\n');

  it('keeps exported declarations without their bodies', () => {
    expect(extractDeclarations('ts', source).map((d) => [d.name, d.isDefault, d.text])).toEqual([
      ['Point', false, 'export interface Point { x: number; y: number }'],
      ['Id', false, 'export type Id = string | number;'],
      ['LIMIT', false, 'export const LIMIT = …;'],
      ['add', false, 'export const add = (a: number, b: number): number => …;'],
      ['run', false, 'export const run = async (s: string) => …;'],
      ['conf', false, 'export const conf: Config;'],
      ['sum', false, 'export function sum(values: number[]): { total: number };'],
      ['fetchJson', false, 'export async function fetchJson<T>(url: string): Promise<T>;'],
      [
        'Store',
        true,
        [
          'export default class Store<T> extends Base<T> {',
          '  readonly name: string;',
          '  static count;',
          '  constructor(private readonly items: T[]);',
          '  get size(): number;',
          '  add(item: T): void;',
          '}',
        ].join('\n'),
      ],
      ['Color', false, 'export enum Color { Red, Green }'],
    ]);
  });

  it('takes top-level functions and classes of a file without ES exports (CommonJS)', () => {
    const cjs =
      'function helper(a, b) {\n  return a;\n}\nclass Box {\n  open() {}\n}\nmodule.exports = { helper, Box };\n';
    expect(extractDeclarations('ts', cjs).map((d) => d.text)).toEqual([
      'function helper(a, b);',
      'class Box {\n  open();\n}',
    ]);
  });

  it('reads past a regular expression that holds quotes and unbalanced brackets', () => {
    const text = [
      "const LIMIT = /\\b(?:you['’]ve hit|\\(open)\\b/i;",
      'const half = total / 2 / count;',
      'export function after(a: number): number {',
      '  return a;',
      '}',
    ].join('\n');
    expect(extractDeclarations('ts', text).map((d) => d.text)).toEqual([
      'export function after(a: number): number;',
    ]);
  });

  it('masks comments and strings without moving any character', () => {
    const text = 'const a = "{"; // }\n/* { */ const b = `x${1}`;';
    const masked = maskSource(text, 'ts');
    expect(masked).toHaveLength(text.length);
    expect(masked).not.toMatch(/[{}]/);
  });
});

describe('extractDeclarations (Python)', () => {
  const source = [
    '"""Doc with def fake(): and class Fake:"""',
    'from dataclasses import dataclass',
    '',
    '@dataclass',
    'class Money:',
    '    """Money."""',
    '    amount: int',
    '    currency: str = "EUR"',
    '',
    '    def __init__(self, amount: int, currency: str = "EUR") -> None:',
    '        self.amount = amount',
    '',
    '    @property',
    '    def label(self) -> str:',
    '        return f"{self.amount}"',
    '',
    '    def _private(self):',
    '        pass',
    '',
    'def add(a: int,',
    '        b: int) -> int:',
    '    # comment: not a header',
    '    return a + b',
    '',
    'async def fetch(url: str) -> dict[str, int]:',
    '    return {}',
    '',
    'def _hidden():',
    '    pass',
  ].join('\n');

  it('keeps functions and classes with fields and public methods, bodies as ...', () => {
    expect(extractDeclarations('python', source).map((d) => [d.name, d.text])).toEqual([
      [
        'Money',
        [
          '@dataclass',
          'class Money:',
          '    amount: int',
          '    currency: str',
          '    def __init__(self, amount: int, currency: str = "EUR") -> None: ...',
          '    @property',
          '    def label(self) -> str: ...',
        ].join('\n'),
      ],
      ['add', 'def add(a: int,\n        b: int) -> int: ...'],
      ['fetch', 'async def fetch(url: str) -> dict[str, int]: ...'],
      ['_hidden', 'def _hidden(): ...'],
    ]);
  });

  it('renders only public names unless they are imported by name', () => {
    const declarations = extractDeclarations('python', source);
    expect(renderDeclarations(declarations, {}, 'python', 600)).not.toContain('_hidden');
    expect(renderDeclarations(declarations, { names: ['_hidden'] }, 'python', 600)).toBe(
      'def _hidden(): ...',
    );
  });
});

describe('renderDeclarations', () => {
  const declarations = extractDeclarations(
    'ts',
    D_TS + 'export default function main(): void {}\n',
  );

  it('keeps named imports, the default export, or everything', () => {
    expect(renderDeclarations(declarations, { names: ['sub'] }, 'ts', 600)).toBe(
      'export function sub(a: number, b: number): number;',
    );
    expect(renderDeclarations(declarations, { names: [], default: true }, 'ts', 600)).toBe(
      'export default function main(): void;',
    );
    expect(renderDeclarations(declarations, {}, 'ts', 600).split('\n')).toHaveLength(3);
  });

  it('cuts at a line end within maxChars', () => {
    const text = renderDeclarations(declarations, {}, 'ts', 60);
    expect(text).toBe('export function add(a: number, b: number): number;');
  });
});

describe('ImportContext.collect', () => {
  const C_TS = "import { add } from './d';\n\nexport const x = add(1, 2);\n";

  it('returns the signatures of an imported file, not its body, with its dependency state', async () => {
    const fs = new MemFs({ '/w/src/c.ts': C_TS, '/w/src/d.ts': D_TS });
    const result = await new ImportContext(fs).collect(input(C_TS));
    expect(result.outcome).toBe('ok');
    expect(result.snippets).toEqual([
      { path: 'src/d.ts', text: 'export function add(a: number, b: number): number;' },
    ]);
    expect(result.snippets[0]!.text).not.toContain('BODY');
    expect(result.dependencies).toEqual([
      {
        kind: 'file',
        path: '/w/src/d.ts',
        realPath: '/w/src/d.ts',
        size: Buffer.byteLength(D_TS),
        mtimeMs: 1,
      },
    ]);
  });

  it('never reads a file excluded by its relative path', async () => {
    const text = "import { mulKey } from '../secrets/keys';\n";
    const fs = new MemFs({
      '/w/src/c.ts': text,
      '/w/secrets/keys.ts': "export const mulKey = 'x';\n",
    });
    const result = await new ImportContext(fs).collect(input(text));
    expect(result.snippets).toEqual([]);
    expect(fs.reads).toEqual([]);
  });

  it('never reads a symlink whose real path is excluded or outside the folder', async () => {
    const text = "import * as env from './link';\nimport * as out from './out';\n";
    const fs = new MemFs({
      '/w/src/c.ts': text,
      '/w/.env': 'export const KEY = 1;\n',
      '/elsewhere/x.ts': 'export function leak(): void {}\n',
    });
    fs.links.set('/w/src/link.ts', '/w/.env');
    fs.links.set('/w/src/out.ts', '/elsewhere/x.ts');
    const result = await new ImportContext(fs).collect(input(text));
    expect(result.snippets).toEqual([]);
    expect(fs.reads).toEqual([]);
  });

  it('skips a file whose realpath fails', async () => {
    const fs = new MemFs({ '/w/src/c.ts': C_TS, '/w/src/d.ts': D_TS });
    fs.failRealpath.add('/w/src/d.ts');
    expect((await new ImportContext(fs).collect(input(C_TS))).snippets).toEqual([]);
    expect(fs.reads).toEqual([]);
  });

  it('reads nothing when the folder has no realpath', async () => {
    const fs = new MemFs({ '/w/src/c.ts': C_TS, '/w/src/d.ts': D_TS });
    fs.failRealpath.add('/w');
    expect((await new ImportContext(fs).collect(input(C_TS))).snippets).toEqual([]);
  });

  it('works when the workspace folder itself is reached through a symlink', async () => {
    const fs = new MemFs({ '/real/w/src/c.ts': C_TS, '/real/w/src/d.ts': D_TS });
    fs.links.set('/w', '/real/w');
    const result = await new ImportContext(fs).collect(input(C_TS));
    expect(result.snippets.map((s) => s.path)).toEqual(['src/d.ts']);
  });

  it('takes the first existing candidate only: an excluded one is not replaced by the next', async () => {
    const text = "import * as d from './d';\n";
    const fs = new MemFs({ '/w/src/c.ts': text, '/w/src/d.ts': D_TS, '/w/src/d/index.ts': D_TS });
    const result = await new ImportContext(fs).collect(input(text, { exclude: ['src/d.ts'] }));
    expect(result.snippets).toEqual([]);
  });

  it('skips a file over the size cap without reading it', async () => {
    const text = "import * as big from './big';\n";
    const fs = new MemFs({
      '/w/src/c.ts': text,
      '/w/src/big.ts': `export const big = 1;${' '.repeat(300 * 1024)}`,
    });
    expect((await new ImportContext(fs).collect(input(text))).snippets).toEqual([]);
    expect(fs.reads).toEqual([]);
  });

  it('stops at the file cap, in import order', async () => {
    const names = ['a', 'b', 'e', 'f'];
    const text = names.map((m) => `import * as ${m} from './${m}';`).join('\n');
    const files: Record<string, string> = { '/w/src/c.ts': text };
    for (const m of names) files[`/w/src/${m}.ts`] = `export function ${m}Fn(): void {}\n`;
    const result = await new ImportContext(new MemFs(files)).collect(input(text));
    expect(result.snippets.map((s) => s.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/e.ts']);
    expect(result.dependencies).toHaveLength(3);
  });

  it('merges the names of two imports of the same file, and skips the document itself', async () => {
    const text =
      "import { add } from './d';\nimport { sub } from './d.js';\nimport * as self from './c';\n";
    const fs = new MemFs({ '/w/src/c.ts': text, '/w/src/d.ts': D_TS });
    const result = await new ImportContext(fs).collect(input(text));
    expect(result.snippets).toEqual([
      {
        path: 'src/d.ts',
        text: 'export function add(a: number, b: number): number;\nexport function sub(a: number, b: number): number;',
      },
    ]);
  });

  it("prefers an open document's unsaved text and records its version", async () => {
    const fs = new MemFs({ '/w/src/c.ts': C_TS, '/w/src/d.ts': D_TS });
    fs.open.set('/w/src/d.ts', {
      uri: 'file:///w/src/d.ts',
      version: 7,
      text: 'export function add(a: string): string {\n  return a;\n}\n',
      isDirty: true,
    });
    const result = await new ImportContext(fs).collect(input(C_TS));
    expect(result.snippets[0]!.text).toBe('export function add(a: string): string;');
    expect(result.dependencies[0]).toMatchObject({ kind: 'document', version: 7 });
    expect(fs.reads).toEqual([]);
  });

  it('reads an open document without unsaved edits from disk, and checks it there', async () => {
    const fs = new MemFs({ '/w/src/c.ts': C_TS, '/w/src/d.ts': D_TS });
    fs.open.set('/w/src/d.ts', {
      uri: 'file:///w/src/d.ts',
      version: 2,
      text: 'export function stale(): void {}\n',
      isDirty: false,
    });
    const context = new ImportContext(fs);
    const result = await context.collect(input(C_TS));
    expect(result.snippets[0]!.text).toBe('export function add(a: number, b: number): number;');
    expect(result.dependencies[0]).toMatchObject({ kind: 'file' });
    fs.files.set('/w/src/d.ts', { text: D_TS, mtimeMs: 9 });
    expect(await context.dependenciesCurrent(result.dependencies, undefined, 50)).toBe('stale');
  });

  it('reuses extracted declarations while the file is unchanged', async () => {
    const fs = new MemFs({ '/w/src/c.ts': C_TS, '/w/src/d.ts': D_TS });
    const context = new ImportContext(fs);
    await context.collect(input(C_TS));
    await context.collect(input(C_TS));
    expect(fs.reads).toHaveLength(1);
    fs.files.set('/w/src/d.ts', { text: D_TS.replace('add', 'plus'), mtimeMs: 2 });
    await context.collect(input(C_TS));
    expect(fs.reads).toHaveLength(2);
  });

  it('gives up at the deadline with no signatures', async () => {
    const fs = new MemFs({ '/w/src/c.ts': C_TS, '/w/src/d.ts': D_TS });
    fs.delayMs = 60;
    const context = new ImportContext(fs, { ...DEFAULT_IMPORT_OPTIONS, deadlineMs: 100 });
    const started = Date.now();
    const result = await context.collect(input(C_TS));
    expect(result).toEqual({ snippets: [], dependencies: [], outcome: 'deadline' });
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('ends at once when the signal aborts', async () => {
    const fs = new MemFs({ '/w/src/c.ts': C_TS, '/w/src/d.ts': D_TS });
    fs.delayMs = 50;
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const result = await new ImportContext(fs).collect(input(C_TS, { signal: controller.signal }));
    expect(result.outcome).toBe('aborted');
  });

  it('reads Python relative imports', async () => {
    const main = 'from .util import add\n\nprint(add(1, 2))\n';
    const fs = new MemFs({
      '/w/pkg/main.py': main,
      '/w/pkg/util.py':
        'def add(a: int, b: int) -> int:\n    return a + b\n\ndef mul(a, b):\n    return a * b\n',
    });
    const result = await new ImportContext(fs).collect(
      input(main, { languageId: 'python', documentPath: '/w/pkg/main.py' }),
    );
    expect(result.snippets).toEqual([
      { path: 'pkg/util.py', text: 'def add(a: int, b: int) -> int: ...' },
    ]);
  });

  it('does nothing for other languages', async () => {
    const fs = new MemFs({ '/w/src/c.go': 'import "./d"' });
    const result = await new ImportContext(fs).collect(input('import "./d"', { languageId: 'go' }));
    expect(result.snippets).toEqual([]);
  });
});

describe('ImportContext.dependenciesCurrent', () => {
  async function collected(fs: MemFs) {
    const context = new ImportContext(fs);
    const text = "import { add } from './d';\n";
    const result = await context.collect(input(text));
    return { context, dependencies: result.dependencies };
  }

  it('is current while the file is unchanged, and stale after a change', async () => {
    const fs = new MemFs({ '/w/src/d.ts': D_TS });
    const { context, dependencies } = await collected(fs);
    expect(await context.dependenciesCurrent(dependencies, undefined, 50)).toBe('current');
    fs.files.set('/w/src/d.ts', { text: D_TS, mtimeMs: 2 });
    expect(await context.dependenciesCurrent(dependencies, undefined, 50)).toBe('stale');
  });

  it('is stale when the file is open with unsaved edits, or deleted', async () => {
    const fs = new MemFs({ '/w/src/d.ts': D_TS });
    const { context, dependencies } = await collected(fs);
    fs.open.set('/w/src/d.ts', { uri: 'file:///w/src/d.ts', version: 2, text: '', isDirty: true });
    expect(await context.dependenciesCurrent(dependencies, undefined, 50)).toBe('stale');
    fs.open.clear();
    fs.files.delete('/w/src/d.ts');
    expect(await context.dependenciesCurrent(dependencies, undefined, 50)).toBe('stale');
  });

  it('is stale when a symlink now points elsewhere, whatever the target extension', async () => {
    const fs = new MemFs({ '/w/data/one.source': D_TS, '/w/data/two.source': D_TS });
    fs.links.set('/w/src/d.ts', '/w/data/one.source');
    const { context, dependencies } = await collected(fs);
    expect(dependencies[0]).toMatchObject({ realPath: '/w/data/one.source' });
    expect(await context.dependenciesCurrent(dependencies, undefined, 50)).toBe('current');
    fs.files.set('/w/data/one.source', { text: D_TS, mtimeMs: 5 });
    expect(await context.dependenciesCurrent(dependencies, undefined, 50)).toBe('stale');
    fs.files.set('/w/data/one.source', { text: D_TS, mtimeMs: 1 });
    fs.links.set('/w/src/d.ts', '/w/data/two.source');
    expect(await context.dependenciesCurrent(dependencies, undefined, 50)).toBe('stale');
  });

  it('follows the version of a document read with unsaved edits', async () => {
    const fs = new MemFs({ '/w/src/d.ts': D_TS });
    fs.open.set('/w/src/d.ts', {
      uri: 'file:///w/src/d.ts',
      version: 3,
      text: D_TS,
      isDirty: true,
    });
    const { context, dependencies } = await collected(fs);
    expect(await context.dependenciesCurrent(dependencies, undefined, 50)).toBe('current');
    fs.open.set('/w/src/d.ts', {
      uri: 'file:///w/src/d.ts',
      version: 4,
      text: D_TS,
      isDirty: true,
    });
    expect(await context.dependenciesCurrent(dependencies, undefined, 50)).toBe('stale');
    fs.open.clear();
    expect(await context.dependenciesCurrent(dependencies, undefined, 50)).toBe('stale');
  });

  it('reports the deadline and an abort instead of blocking', async () => {
    const fs = new MemFs({ '/w/src/d.ts': D_TS });
    const { context, dependencies } = await collected(fs);
    fs.delayMs = 200;
    expect(await context.dependenciesCurrent(dependencies, undefined, 50)).toBe('deadline');
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    expect(await context.dependenciesCurrent(dependencies, controller.signal, 500)).toBe('aborted');
  });
});

describe('inspection fixes (phase-3-context round 1)', () => {
  it('keeps offsets right after characters outside the BMP (CTX-I001)', () => {
    expect(
      extractDeclarations('ts', '// 😀😀\nexport function add(): number {\n  return 1;\n}\n').map(
        (d) => d.text,
      ),
    ).toEqual(['export function add(): number;']);
    expect(parseImports("// 😀\nconst s = '😀';\nimport { a } from './a';\n", 'ts', 20)).toEqual([
      { specifier: './a', wanted: { names: ['a'] } },
    ]);
    expect(
      extractDeclarations('python', '# 😀\ndef add(a: int) -> int:\n    return a\n').map(
        (d) => d.text,
      ),
    ).toEqual(['def add(a: int) -> int: ...']);
  });

  it('finds no import inside strings, template literals or docstrings (CTX-I002)', () => {
    const ts = [
      "const doc = `import { add } from './d';`;",
      'const s = "import { b } from \'./b\'";',
      "import { real } from './real';",
    ].join('\n');
    expect(parseImports(ts, 'ts', 20)).toEqual([
      { specifier: './real', wanted: { names: ['real'] } },
    ]);
    const py = ['"""', 'from .util import add', '"""', 'from .real import x'].join('\n');
    expect(parseImports(py, 'python', 20)).toEqual([
      { specifier: '.real', wanted: { names: ['x'] } },
    ]);
  });

  it('resolves local export lists, aliases and `export default name` (CTX-I003)', () => {
    const text = [
      'function add(a: number): number {',
      '  return a;',
      '}',
      'const sub = (a: number): number => -a;',
      'function main(): void {}',
      'function hidden(): void {}',
      'export { add, sub as minus };',
      "export { other } from './other';",
      'export default main;',
    ].join('\n');
    const declarations = extractDeclarations('ts', text);
    expect(renderDeclarations(declarations, { names: ['add'] }, 'ts', 600)).toBe(
      'function add(a: number): number;',
    );
    expect(renderDeclarations(declarations, { names: ['minus'] }, 'ts', 600)).toBe(
      'const sub = (a: number): number => …;\nexport { sub as minus };',
    );
    expect(renderDeclarations(declarations, { names: [], default: true }, 'ts', 600)).toBe(
      'function main(): void;\nexport default main;',
    );
    expect(renderDeclarations(declarations, {}, 'ts', 600)).not.toContain('hidden');
    expect(renderDeclarations(declarations, { names: ['other'] }, 'ts', 600)).toBe('');
  });

  it('is stale when an editor gets unsaved edits while the file system is awaited (CTX-I005)', async () => {
    const fs = new MemFs({ '/w/src/d.ts': D_TS });
    const context = new ImportContext(fs);
    const result = await context.collect(input("import { add } from './d';\n"));
    fs.delayMs = 40;
    const pending = context.dependenciesCurrent(result.dependencies, undefined, 1000);
    setTimeout(() => {
      fs.open.set('/w/src/d.ts', {
        uri: 'file:///w/src/d.ts',
        version: 2,
        text: '',
        isDirty: true,
      });
    }, 50);
    expect(await pending).toBe('stale');
  });

  it('stays fast on inputs built to defeat the heuristics (security review S1)', () => {
    const MiB = 1024 * 1024;
    const cases: [string, () => unknown][] = [
      ['ts imports', () => parseImports('import a '.repeat(MiB / 9), 'ts', 20)],
      ['ts require', () => parseImports('const a '.repeat(MiB / 8), 'ts', 20)],
      ['python from', () => parseImports('from .a import (b\n'.repeat(MiB / 18), 'python', 20)],
      ['ts exports', () => extractDeclarations('ts', 'export function f(\n'.repeat(13_000))],
      [
        'ts members',
        () => extractDeclarations('ts', `export class C {\n${'  a(\n'.repeat(50_000)}`),
      ],
      [
        'ts statements',
        () => extractDeclarations('ts', `export type T =\n${'| A\n'.repeat(60_000)}`),
      ],
      ['python defs', () => extractDeclarations('python', 'def f(\n'.repeat(37_000))],
    ];
    for (const [label, run] of cases) {
      const started = performance.now();
      run();
      expect(performance.now() - started, label).toBeLessThan(1000);
    }
  });
});

describe('inspection fixes (phase-3-context round 2)', () => {
  it('stays linear on whitespace-heavy incomplete statements and unclosed regular expressions (CTX-I007)', () => {
    const KiB = 1024;
    const cases: [string, () => unknown][] = [
      ['import + spaces', () => parseImports(`import${' '.repeat(60 * KiB)}`, 'ts', 20)],
      [
        'import + spaces, repeated',
        () => parseImports(`import ${' '.repeat(500)}`.repeat(120), 'ts', 20),
      ],
      ['const + spaces', () => parseImports(`const${' '.repeat(60 * KiB)}`, 'ts', 20)],
      ['require + spaces', () => parseImports(`x = require${' '.repeat(60 * KiB)}`, 'ts', 20)],
      ['python dots', () => parseImports(`from ${'.'.repeat(60 * KiB)}`, 'python', 20)],
      ['python spaces', () => parseImports(`from ${' '.repeat(60 * KiB)}`, 'python', 20)],
      ['unclosed regex', () => maskSource('=/['.repeat((256 * KiB) / 3), 'ts')],
      ['open clauses', () => parseImports('import {'.repeat((64 * KiB) / 8), 'ts', 20)],
    ];
    for (const [label, run] of cases) {
      const started = performance.now();
      run();
      expect(performance.now() - started, label).toBeLessThan(1000);
    }
  });

  it('still reads every import form with the scanner', () => {
    const text = [
      "import{a}from'./compact';",
      "import type from './type-default';",
      "import { from } from './named-from';",
      "import type { T } from './types';",
      "const lazy = import('./dynamic');",
      "import './side-effect';",
      "const { r } = require('./req');",
      "const whole =\n  require('./multiline');",
      "if (x == require('./compare')) {}",
    ].join('\n');
    expect(parseImports(text, 'ts', 20)).toEqual([
      { specifier: './compact', wanted: { names: ['a'] } },
      { specifier: './type-default', wanted: { names: [], default: true } },
      { specifier: './named-from', wanted: { names: ['from'] } },
      { specifier: './types', wanted: { names: ['T'] } },
      { specifier: './req', wanted: { names: ['r'] } },
      { specifier: './multiline', wanted: {} },
    ]);
  });

  it('sees unsaved edits in either editor of a symlinked file (CTX-I008)', async () => {
    const text = "import { add } from './link';\n";
    const fs = new MemFs({ '/w/lib/d.ts': D_TS });
    fs.links.set('/w/src/link.ts', '/w/lib/d.ts');
    // A clean editor on the symlink, a dirty one on its target.
    fs.open.set('/w/src/link.ts', {
      uri: 'file:///w/src/link.ts',
      version: 1,
      text: D_TS,
      isDirty: false,
    });
    fs.open.set('/w/lib/d.ts', {
      uri: 'file:///w/lib/d.ts',
      version: 5,
      text: 'export function add(x: string): string {\n  return x;\n}\n',
      isDirty: true,
    });
    const context = new ImportContext(fs);
    const result = await context.collect(input(text));
    expect(result.snippets[0]!.text).toBe('export function add(x: string): string;');
    expect(result.dependencies[0]).toMatchObject({ kind: 'document', uri: 'file:///w/lib/d.ts' });
    expect(await context.dependenciesCurrent(result.dependencies, undefined, 50)).toBe('current');
    // The clean alias gets unsaved edits too: the recorded text may no longer be the one in use.
    fs.open.set('/w/src/link.ts', {
      uri: 'file:///w/src/link.ts',
      version: 2,
      text: '',
      isDirty: true,
    });
    expect(await context.dependenciesCurrent(result.dependencies, undefined, 50)).toBe('stale');

    // A file read from disk is stale once any of its editors has unsaved edits.
    const disk = new MemFs({ '/w/lib/d.ts': D_TS });
    disk.links.set('/w/src/link.ts', '/w/lib/d.ts');
    disk.open.set('/w/src/link.ts', {
      uri: 'file:///w/src/link.ts',
      version: 1,
      text: D_TS,
      isDirty: false,
    });
    const fromDisk = new ImportContext(disk);
    const read = await fromDisk.collect(input(text));
    expect(read.dependencies[0]).toMatchObject({ kind: 'file' });
    disk.open.set('/w/lib/d.ts', {
      uri: 'file:///w/lib/d.ts',
      version: 3,
      text: '',
      isDirty: true,
    });
    expect(await fromDisk.dependenciesCurrent(read.dependencies, undefined, 50)).toBe('stale');
  });

  it('resolves export lists and defaults that name an exported declaration (CTX-I009)', () => {
    const text = [
      'export function add(a: number): number {',
      '  return a;',
      '}',
      'export { add as sum };',
      'export default add;',
    ].join('\n');
    const declarations = extractDeclarations('ts', text);
    expect(renderDeclarations(declarations, { names: [], default: true }, 'ts', 600)).toBe(
      'export function add(a: number): number;\nexport default add;',
    );
    expect(renderDeclarations(declarations, { names: ['sum'] }, 'ts', 600)).toBe(
      'export function add(a: number): number;\nexport { add as sum };',
    );
    expect(renderDeclarations(declarations, { names: ['add'] }, 'ts', 600)).toBe(
      'export function add(a: number): number;',
    );
  });
});

describe('extra inspection fix (phase-3-context, outside the bounds)', () => {
  // A synchronous endless loop would hang vitest itself, so the parser runs in a child process
  // with a hard timeout (CTX-I010).
  it('ends on a keyword prefix at the start of the binding window (CTX-I010)', () => {
    const script = [
      "const { parseImports } = await import('./src/core/context/imports.ts');",
      'const cases = [',
      '  "constant = require(\'./x\');",',
      '  "variable = require(\'./x\');",',
      '  "letter = require(\'./x\');",',
      "  \"x = 1; constant = require('./y'); const z = require('./z');\",",
      '];',
      "process.stdout.write(JSON.stringify(cases.map((c) => parseImports(c, 'ts', 20))));",
    ].join('\n');
    const child = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', script],
      { cwd: join(__dirname, '..', '..'), timeout: 20_000, encoding: 'utf8' },
    );
    expect(child.error, 'the parser must not hang').toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual([[], [], [], [{ specifier: './z', wanted: {} }]]);
  });
});

describe('failures inside the heuristics', () => {
  it('gives no signatures and a stale check instead of failing the request', async () => {
    const fs = new MemFs({ '/w/src/c.ts': "import { add } from './d';\n", '/w/src/d.ts': D_TS });
    const context = new ImportContext(fs);
    const read = await context.collect(input("import { add } from './d';\n"));
    const broken = new ImportContext({
      ...fs,
      realpath: (path: string) => fs.realpath(path),
      stat: (path: string) => fs.stat(path),
      readFile: (path: string) => fs.readFile(path),
      openDocument: () => {
        throw new Error('broken editor lookup');
      },
    });
    expect(await broken.collect(input("import { add } from './d';\n"))).toEqual({
      snippets: [],
      dependencies: [],
      outcome: 'error',
    });
    expect(await broken.dependenciesCurrent(read.dependencies, undefined, 50)).toBe('stale');
  });
});
