// T8 of docs/plans/phase-4-tools.md with real files in two temporary roots (the multi-root cases),
// and the input-side rules of the inspection round 1 fixes.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isExcluded } from '../../src/core/context/exclude';
import {
  inputExcluded,
  isCommandValue,
  commandFolders,
  commandValues,
  isExcludedToolValue,
  mapInputStrings,
  type ToolInputDeps,
} from '../../src/features/chat/toolInput';

const EXCLUDE = ['.env*', '*.pem', 'secrets/**'];
let base: string;
let rootA: string;
let rootB: string;
/** Without the content net's file list: wildcards and directory arguments fail closed. */
let deps: ToolInputDeps;
/** With a complete list of the excluded files. */
let wild: ToolInputDeps;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'magipilot-toolinput-')));
  rootA = join(base, 'a');
  rootB = join(base, 'b');
  mkdirSync(join(rootA, 'secrets'), { recursive: true });
  mkdirSync(join(rootA, 'src'), { recursive: true });
  mkdirSync(join(rootA, 'sp ace'), { recursive: true });
  mkdirSync(join(rootB, 'src'), { recursive: true });
  // Every line shorter than the content net's 8 characters: only T8 can keep it out.
  writeFileSync(join(rootA, '.env'), 'K=1\nX=ab\n');
  writeFileSync(join(rootA, 'secrets', 'key'), 'abc\n');
  writeFileSync(join(rootA, 'secrets', 'sp ace.txt'), 'abc\n');
  writeFileSync(join(rootB, 'src', 'only-b.ts'), 'export const b = 1;\n');
  writeFileSync(join(rootA, 'src', 'math.ts'), 'export function add() {}\n');
  symlinkSync(join('secrets', 'key'), join(rootA, 'alias.txt'));
  symlinkSync(join(rootA, '.env'), join(rootA, 'src', 'abs-alias.txt'));
  symlinkSync(join('..', '.env'), join(rootA, 'sp ace', 'alias.txt'));
  symlinkSync('secrets', join(rootA, 'linkdir'));
  const roots = [rootA, rootB];
  deps = {
    roots,
    // As the extension does: an absolute path relative to its folder, other values as given.
    matches: (path) => {
      let candidate = path;
      if (isAbsolute(path)) {
        const root = roots.find((r) => path === r || path.startsWith(r + sep));
        if (root) candidate = relative(root, path);
      }
      return isExcluded(candidate, EXCLUDE);
    },
    realpath: (path) => {
      try {
        return realpathSync(path);
      } catch {
        return undefined;
      }
    },
    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
  };
  wild = {
    ...deps,
    excludedPaths: new Set([
      join(rootA, '.env'),
      join(rootA, 'secrets', 'key'),
      join(rootA, 'secrets', 'sp ace.txt'),
    ]),
    excludedPathsComplete: true,
  };
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('isExcludedToolValue (T8)', () => {
  it('excludes a value that matches the patterns as given', () => {
    expect(isExcludedToolValue('.env', wild)).toBe(true);
    expect(isExcludedToolValue('secrets/key', wild)).toBe(true);
    expect(isExcludedToolValue('**/*.pem', wild)).toBe(true);
  });

  it('excludes an absolute path, an encoded file URI and an absolute symlink alias', () => {
    expect(isExcludedToolValue(join(rootA, '.env'), wild)).toBe(true);
    const uri = pathToFileURL(join(rootA, 'secrets', 'sp ace.txt')).href;
    expect(uri).toContain('%20');
    expect(isExcludedToolValue(uri, wild)).toBe(true);
    expect(isExcludedToolValue(join(rootA, 'src', 'abs-alias.txt'), wild)).toBe(true);
    expect(isExcludedToolValue(pathToFileURL(join(rootA, 'src', 'abs-alias.txt')).href, wild)).toBe(
      true,
    );
  });

  it('excludes a relative symlink alias of an excluded file through its realpath', () => {
    expect(wild.matches('alias.txt')).toBe(false);
    expect(isExcludedToolValue('alias.txt', wild)).toBe(true);
    expect(isExcludedToolValue('./alias.txt', wild)).toBe(true);
  });

  it('fails closed on a malformed URI; other multi-line values are text', () => {
    expect(isExcludedToolValue('file://remote-host/etc/hosts', wild)).toBe(true);
    expect(isExcludedToolValue('file:///ws/a%0Ab', wild)).toBe(true);
    // Text that starts with `/` (a code comment) is not a malformed path; its words still count.
    expect(isExcludedToolValue(`${join(rootA, 'src', 'math.ts')}\n`, wild)).toBe(false);
    expect(isExcludedToolValue('// comment\nconst a = 1;', wild)).toBe(false);
    expect(isExcludedToolValue(`// see ${join(rootA, '.env')}\nconst a = 1;`, wild)).toBe(true);
  });

  it('keeps ordinary values (plan review P4T-R003)', () => {
    for (const value of [
      'export function add',
      'add(',
      '',
      // Exists in root b only: the absent candidate in root a excludes nothing.
      'src/only-b.ts',
      'src/math.ts',
      join(rootA, 'src', 'math.ts'),
      join(rootA, 'src', 'absent.ts'),
      pathToFileURL(join(rootB, 'src', 'only-b.ts')).href,
      // A multi-line search query is not a path.
      'function\nadd',
      // A query with an apostrophe, a `$` and a directory: not a command line.
      "don't add $scope here",
      rootA,
      '.',
    ]) {
      expect(isExcludedToolValue(value, wild), JSON.stringify(value)).toBe(false);
    }
  });
});

describe('words of a value', () => {
  it('excludes a command line or a flag that names an excluded file', () => {
    expect(isExcludedToolValue('cat .env', wild)).toBe(true);
    expect(isExcludedToolValue('grep -r KEY secrets/key', wild)).toBe(true);
    expect(isExcludedToolValue('tool --file=.env.local', wild)).toBe(true);
    expect(isExcludedToolValue('head -n 1 ./alias.txt', wild)).toBe(true);
    expect(isExcludedToolValue(`wc -l "${join(rootA, 'src', 'abs-alias.txt')}"`, wild)).toBe(true);
    expect(isExcludedToolValue('cat src/math.ts; cat alias.txt', wild)).toBe(true);
  });

  it('keeps ordinary command lines', () => {
    for (const value of ['npm test', 'git status --short', 'cat src/math.ts', 'ls src']) {
      expect(isExcludedToolValue(value, wild, true), value).toBe(false);
    }
  });

  it('checks every word of a long value, with lookups (security review of c58d56c)', () => {
    const long = `${'x '.repeat(3000)}cat alias.txt`;
    expect(long.length).toBeGreaterThan(4096);
    expect(isExcludedToolValue(long, wild)).toBe(true);
    expect(isExcludedToolValue(`${'x '.repeat(3000)}cat src/math.ts`, wild)).toBe(false);
  });

  it('counts a value with more distinct words than it checks as excluded', () => {
    const words = Array.from({ length: 20_001 }, (_, i) => `w${i}`).join(' ');
    expect(isExcludedToolValue(words, wild)).toBe(true);
  });

  it('joins quoted segments as a shell does (security review of c58d56c)', () => {
    expect(isExcludedToolValue("cat '.e'nv", wild)).toBe(true);
    expect(isExcludedToolValue('cat ".e"nv', wild)).toBe(true);
    expect(isExcludedToolValue('cat \\.env', wild)).toBe(true);
    expect(isExcludedToolValue("cat 'ali'as.txt", wild)).toBe(true);
    expect(isExcludedToolValue("echo 'hello world'", wild, true)).toBe(false);
  });

  it('keeps quoted and escaped spaces inside a word (inspection P4T-I002)', () => {
    expect(isExcludedToolValue('cat "sp ace/alias.txt"', wild, true)).toBe(true);
    expect(isExcludedToolValue("cat 'sp ace/alias.txt'", wild)).toBe(true);
    expect(isExcludedToolValue('cat sp\\ ace/alias.txt', wild)).toBe(true);
    expect(isExcludedToolValue(`cat "${join(rootA, 'sp ace', 'alias.txt')}"`, wild)).toBe(true);
    expect(isExcludedToolValue('cat "sp ace/missing.txt"', wild, true)).toBe(false);
  });
});

describe('command lines (inspection round 1 and the security review of ef80659)', () => {
  it('fails closed on substitution, an unclosed quote and words that run other input', () => {
    for (const value of [
      'cat $(ls -a | grep e)',
      'cat `ls`',
      'cat "src/math.ts',
      'ls | xargs cat',
      'find src -name x -exec cat {} ;',
      'sh -c "cat x"',
      'eval something',
    ]) {
      expect(isExcludedToolValue(value, wild, true), value).toBe(true);
    }
    // The same text in a query is not a command.
    expect(isExcludedToolValue("don't", wild, false)).toBe(false);
    expect(isExcludedToolValue('ls | xargs cat', wild, false)).toBe(false);
  });

  it('excludes a directory argument with an excluded file beneath it', () => {
    expect(isExcludedToolValue('grep -r KEY .', wild, true)).toBe(true);
    expect(isExcludedToolValue(`grep -r KEY ${rootA}`, wild, true)).toBe(true);
    expect(isExcludedToolValue('grep -r KEY secrets/', wild, true)).toBe(true);
    expect(isExcludedToolValue('grep -r KEY linkdir', wild, true)).toBe(true);
    // Not a recursive search: a folder without an excluded file beneath it is kept.
    expect(isExcludedToolValue('ls src', wild, true)).toBe(false);
    expect(isExcludedToolValue('cat secrets/', wild, true)).toBe(true);
  });

  it('counts a variable in a command line as excluded, not in a query', () => {
    for (const value of ['cat .e$X', 'cat $F', 'cat src/$F', 'cat src/x${F}.ts', 'echo $HOME']) {
      expect(isExcludedToolValue(value, wild, true), value).toBe(true);
    }
    expect(isExcludedToolValue('cat .e$X', wild, false)).toBe(false);
    // No excluded file in the workspace: nothing to reach.
    expect(
      isExcludedToolValue('echo $HOME', { ...wild, excludedPaths: new Set<string>() }, true),
    ).toBe(false);
  });

  it('treats a recursive search without a folder as a search of the root (security review)', () => {
    for (const value of [
      'rg KEY',
      'grep -rn KEY',
      'grep -R KEY',
      'git grep KEY',
      'find -name x',
      'ls -laR',
      'tree',
    ]) {
      expect(isExcludedToolValue(value, wild, true), value).toBe(true);
    }
    for (const value of ['grep -n KEY src/math.ts', 'ls -la', 'git status']) {
      expect(isExcludedToolValue(value, wild, true), value).toBe(false);
    }
    const none = { ...wild, excludedPaths: new Set<string>() };
    expect(isExcludedToolValue('rg KEY', none, true)).toBe(false);
  });

  it('fails closed on ANSI-C and locale quoting in a command line (security review)', () => {
    expect(isExcludedToolValue("cat $'\\x2eenv'", wild, true)).toBe(true);
    expect(isExcludedToolValue('cat $"x"', wild, true)).toBe(true);
  });

  it('tells command values by the tool name and the key', () => {
    expect(isCommandValue('run_in_terminal', 'explanation')).toBe(true);
    expect(isCommandValue('mcp_shell', undefined)).toBe(true);
    expect(isCommandValue('custom_tool', 'command')).toBe(true);
    expect(isCommandValue('custom_tool', 'args')).toBe(true);
    expect(isCommandValue('read_file', 'filePath')).toBe(false);
    expect(isCommandValue('grep_search', 'query')).toBe(false);
    expect(isCommandValue('run_notebook_cell', 'cellId')).toBe(true);
    expect(isCommandValue('mcp_python_execute', 'input')).toBe(true);
    expect(isCommandValue('custom_tool', 'code')).toBe(true);
    // Not commands: their inputs hold code and prose (a recorded trade-off).
    expect(isCommandValue('replace_string_in_file', 'oldString')).toBe(false);
    expect(isCommandValue('runSubagent', 'prompt')).toBe(false);
  });
});

describe('wildcards against the excluded files the index found (security reviews)', () => {
  it('excludes a wildcard, a bracket class or a brace list that can reach one', () => {
    for (const value of [
      'cat .e*',
      'cat .en?',
      'cat .[e]nv',
      'cat {.env,README.md}',
      'cat secret*/*',
      `cat ${join(rootA, '.e*')}`,
      'grep -r KEY **/k*',
      // Through the realpath of its fixed directory part (linkdir → secrets).
      'cat linkdir/*',
    ]) {
      expect(isExcludedToolValue(value, wild, true), value).toBe(true);
    }
    // A single glob value too (a search tool's include pattern), not only in a command line.
    expect(isExcludedToolValue('.e*', wild, false)).toBe(true);
    expect(isExcludedToolValue('**/k*', wild, false)).toBe(true);
    // The words of a plain value are text, not globs.
    expect(isExcludedToolValue('cat .e*', wild, false)).toBe(false);
  });

  it('keeps wildcards that cannot reach one', () => {
    for (const value of ['ls src/*', 'grep -n add src/**/*.ts', 'src/**/*.ts', 'foo.*bar']) {
      expect(isExcludedToolValue(value, wild, true), value).toBe(false);
      expect(isExcludedToolValue(value, wild, false), value).toBe(false);
    }
  });

  it('fails closed without a complete list, or for a word too wild to match safely', () => {
    expect(isExcludedToolValue('cat .e*', deps, true)).toBe(true);
    expect(isExcludedToolValue('src/**/*.ts', { ...wild, excludedPathsComplete: false })).toBe(
      true,
    );
    expect(isExcludedToolValue('grep -r KEY src', deps, true)).toBe(true);
    expect(isExcludedToolValue(`cat ${'*'.repeat(9)}x`, wild, true)).toBe(true);
    expect(isExcludedToolValue(`cat ${'a'.repeat(600)}*`, wild, true)).toBe(true);
    // Runs of `**/` collapse before matching (a bounded regular expression).
    expect(isExcludedToolValue(`grep -n a ${'**/'.repeat(50)}*.ts`, wild, true)).toBe(false);
    // No excluded file at all: nothing to reach.
    const none = { ...wild, excludedPaths: new Set<string>() };
    expect(isExcludedToolValue('cat .e*', none, true)).toBe(false);
  });
});

describe('a workspace root reached through a symlink (re-inspection P4T-RI002)', () => {
  it('matches wildcards and folders whatever form the index found the paths in', () => {
    // As on macOS, where /tmp is a link to /private/tmp: the folder is opened by its link, and
    // the index holds the paths under that link.
    const linkRoot = join(base, 'linkroot');
    symlinkSync(rootA, linkRoot);
    const viaLink: ToolInputDeps = {
      ...wild,
      roots: [linkRoot],
      matches: (path) => {
        const root = [linkRoot, rootA].find((r) => path.startsWith(r + sep));
        return isExcluded(root ? relative(root, path) : path, EXCLUDE);
      },
      excludedPaths: new Set([join(linkRoot, '.env'), join(linkRoot, 'secrets', 'key')]),
    };
    expect(isExcludedToolValue('cat linkdir/*', viaLink, true)).toBe(true);
    expect(isExcludedToolValue('grep -r KEY linkdir', viaLink, true)).toBe(true);
    expect(isExcludedToolValue(`cat ${join(rootA, 'linkdir')}/*`, viaLink, true)).toBe(true);
    expect(isExcludedToolValue('cat src/*', viaLink, true)).toBe(false);
  });
});

describe("wildcard characters in a root's own name (security review of 9cbceaa)", () => {
  it('keeps the root literal and matches only the pattern after the fixed folder', () => {
    const odd = join(base, 'ro{o}t [1]*');
    mkdirSync(join(odd, 'secrets'), { recursive: true });
    writeFileSync(join(odd, '.env'), 'K=1\n');
    writeFileSync(join(odd, 'secrets', 'key'), 'abc\n');
    const oddDeps: ToolInputDeps = {
      ...wild,
      roots: [odd],
      matches: (path) =>
        isExcluded(path.startsWith(odd + sep) ? relative(odd, path) : path, EXCLUDE),
      excludedPaths: new Set([join(odd, '.env'), join(odd, 'secrets', 'key')]),
    };
    expect(isExcludedToolValue('cat .e*', oddDeps, true)).toBe(true);
    expect(isExcludedToolValue('cat secrets/*', oddDeps, true)).toBe(true);
    expect(isExcludedToolValue('cat src/*', oddDeps, true)).toBe(false);
  });

  it('counts a wildcard pattern with a dot segment as excluded (security review of 2466635)', () => {
    expect(isExcludedToolValue('cat src/*/../.env', wild, true)).toBe(true);
    expect(isExcludedToolValue('cat src/*/./x', wild, true)).toBe(true);
    // Segments that can match `..` in a shell (security review of 0bd9302).
    for (const value of [
      'cat src/*/.*/.env',
      'cat src/*/.?/.env',
      'cat src/*/.[.]/.env',
      'cat src/*/{..,a}/.env',
    ]) {
      expect(isExcludedToolValue(value, wild, true), value).toBe(true);
    }
    // A leading-dot segment that cannot be `..`, and a plain `*`, stay matchable.
    expect(isExcludedToolValue('ls src/*/.git*', wild, true)).toBe(false);
    expect(isExcludedToolValue('ls src/*/*.ts', wild, true)).toBe(false);
    // In the fixed part `..` is resolved as a path.
    expect(isExcludedToolValue('cat src/../secrets/*', wild, true)).toBe(true);
    expect(isExcludedToolValue('cat src/../src/*', wild, true)).toBe(false);
  });
});

describe('brace expansion and variable segments (inspection PUB-I001, security review)', () => {
  it('checks the paths a brace list names', () => {
    for (const value of [
      'cat src/{../,x/}secrets/key 2>/dev/null',
      'cat src/{x,{..,y}}/secrets/key',
      'cat {src,secrets}/key',
      'cat {a,.env}',
    ]) {
      expect(isExcludedToolValue(value, wild, true), value).toBe(true);
    }
    expect(isExcludedToolValue('cat {a,b}.ts', wild, true)).toBe(false);
    expect(isExcludedToolValue('cat src/{math,b}.ts', wild, true)).toBe(false);
    // A group without a comma is literal, as in a shell.
    expect(isExcludedToolValue('cat src/{math}.ts', wild, true)).toBe(false);
  });

  it('counts a range or a too long word with braces as excluded (re-inspection)', () => {
    expect(isExcludedToolValue('cat s{e..e}crets/key', wild, true)).toBe(true);
    expect(isExcludedToolValue('echo {1..3}', wild, true)).toBe(true);
    const long = `echo ${'{'.repeat(50_000)}`;
    const started = Date.now();
    expect(isExcludedToolValue(long, wild, true)).toBe(true);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('keeps code in a value that is not a command (an edit), whatever its wildcards', () => {
    const code = Array.from(
      { length: 30 },
      (_, i) => `const {a${i}, b${i}} = f({x, y}); const p${i} = a * b ? c[0] : d?.e ?? '*';`,
    ).join('\n');
    expect(code.length).toBeGreaterThan(512);
    expect(isExcludedToolValue(code, wild, false)).toBe(false);
    expect(isExcludedToolValue(code, deps, false)).toBe(false);
    expect(isExcludedToolValue('const p = a * b ? c : d;', wild, false)).toBe(false);
    // As a command line the same text fails closed.
    expect(isExcludedToolValue(code, wild, true)).toBe(true);
  });

  it('matches a single-line plain value as one glob, and bounds it (security review of 3d35f7f)', () => {
    expect(isExcludedToolValue('const p = a * b ? c : d;', wild, false)).toBe(false);
    expect(isExcludedToolValue(`${'*'.repeat(9)}.env`, wild, false)).toBe(true);
    expect(isExcludedToolValue(`${'a'.repeat(600)}*`, wild, false)).toBe(true);
    expect(isExcludedToolValue('.e* README.md', wild, false)).toBe(false);
  });

  it('counts too many expansions as excluded', () => {
    expect(isExcludedToolValue('echo {a,b}{c,d}{e,f}{g,h}{i,j}{k,l}{m,n}', wild, true)).toBe(true);
  });

  it('counts a variable anywhere in a command word as excluded (it may hold slashes)', () => {
    expect(isExcludedToolValue('cat $D/secrets/key', wild, true)).toBe(true);
    expect(isExcludedToolValue('cat src/*/${X}/.env', wild, true)).toBe(true);
    expect(isExcludedToolValue('cat src/$X.ts', wild, true)).toBe(true);
  });
});

describe('inputExcluded and mapInputStrings (T8, P4T-I001)', () => {
  const value = (v: string, key: string | undefined): boolean =>
    isExcludedToolValue(v, wild, isCommandValue('tool', key));

  it('walks every string value of the input with its key, not the keys themselves', () => {
    expect(inputExcluded({ filePath: join(rootA, 'src', 'math.ts') }, value)).toBe(false);
    expect(inputExcluded({ filePaths: ['src/math.ts', 'alias.txt'] }, value)).toBe(true);
    expect(inputExcluded({ nested: { deeper: [{ path: '.env.local' }] } }, value)).toBe(true);
    expect(inputExcluded({ '.env': 'src/math.ts' }, value)).toBe(false);
    expect(inputExcluded({ startLine: 1, path: undefined }, value)).toBe(false);
    expect(inputExcluded({ command: 'grep -r KEY .' }, value)).toBe(true);
    expect(inputExcluded({ query: 'grep -r KEY .' }, value)).toBe(false);
  });

  it('counts an input nested deeper than any schema needs as excluded', () => {
    let deep: unknown = 'src/math.ts';
    for (let i = 0; i < 40; i++) deep = [deep];
    expect(inputExcluded(deep, value)).toBe(true);
  });

  it('maps every string value, keeping keys and other values', () => {
    expect(
      mapInputStrings({ a: 'x', b: ['y', 2, { c: 'z' }], d: true }, (s) => s.toUpperCase()),
    ).toEqual({ a: 'X', b: ['Y', 2, { c: 'Z' }], d: true });
  });
});

describe('command lines from an unknown folder (phase-4-hardening.md AC6)', () => {
  const run = (value: string, given: ToolInputDeps): boolean =>
    isExcludedToolValue(value, given, true);
  /** With an excluded file deeper in the tree (only its path matters for the tail rules). */
  let deeper: ToolInputDeps;
  beforeAll(() => {
    deeper = {
      ...wild,
      excludedPaths: new Set([...wild.excludedPaths!, join(rootA, 'pkg', 'conf', 'settings.json')]),
    };
  });

  it('(a) catches a name relative to a folder the conversation never entered', () => {
    // A terminal already inside secrets/ (P4H-003): no cd in sight.
    expect(run('cat key', wild)).toBe(true);
    expect(run('cat ../.env', wild)).toBe(true);
    expect(run('head ./key', wild)).toBe(true);
    expect(run('cat conf/settings.json', deeper)).toBe(true);
    expect(run('cat settings.json', deeper)).toBe(true);
    expect(run('cat ../../pkg/conf/settings.json', deeper)).toBe(true);
    // Another file of that name elsewhere is not the excluded one.
    expect(run('cat other/settings.json', deeper)).toBe(false);
    expect(run('cat src/math.ts', deeper)).toBe(false);
  });

  it('(a) matches a relative glob against the end of an excluded path', () => {
    expect(run('cat k*', wild)).toBe(true);
    expect(run('cat ../secrets/k?y', wild)).toBe(true);
    expect(run('cat conf/*.json', deeper)).toBe(true);
    expect(run('cat src/*.ts', deeper)).toBe(false);
    expect(run('ls *.md', deeper)).toBe(false);
  });

  it('a recursive search counts as excluded; naming a folder alone does not', () => {
    expect(run('rg TOKEN conf', deeper)).toBe(true);
    expect(run('grep -r TOKEN pkg', deeper)).toBe(true);
    // Not recursive: naming the folder reads no file.
    expect(run('ls conf', deeper)).toBe(false);
  });

  it('counts every command line as excluded without a complete list of excluded files', () => {
    expect(run('echo hi', { ...wild, excludedPathsComplete: false })).toBe(true);
    expect(run('echo hi', deps)).toBe(true);
    // A value that is not a command line keeps its rules.
    expect(isExcludedToolValue('hi', { ...wild, excludedPathsComplete: false })).toBe(false);
  });

  it('(b) resolves the folders that cd, pushd, -C, --prefix, --cwd, --dir and --directory name', () => {
    const real = (path: string): string => realpathSync(path);
    const found = commandFolders(
      [
        'cd src && cat abs-alias.txt',
        "pushd 'sp ace'",
        'git -C secrets status',
        'npm --prefix=src test',
        'make -Csrc',
        'cd -P linkdir',
      ],
      deps,
    );
    expect(found.unknown).toBe(false);
    expect(new Set(found.folders)).toEqual(
      new Set([
        join(rootA, 'src'),
        join(rootB, 'src'),
        join(rootA, 'sp ace'),
        join(rootA, 'secrets'),
        join(rootA, 'linkdir'),
        real(join(rootA, 'linkdir')),
      ]),
    );
    // Relative to a folder found before, in any order of the calls.
    const nested = commandFolders(['cd ..', 'cd src'], { ...deps, roots: [join(rootA, 'src')] });
    expect(nested.folders).toContain(rootA);
    expect(nested.unknown).toBe(false);
    // A target that does not exist is ignored.
    expect(commandFolders(['cd nowhere'], deps)).toEqual({ folders: [], unknown: false });
    // zsh: chdir, and auto_cd (a folder as the command); a word that is no folder is ignored.
    expect(commandFolders(['chdir src'], deps).folders).toContain(join(rootA, 'src'));
    expect(commandFolders(['src', 'npm test'], deps).folders).toContain(join(rootA, 'src'));
    expect(commandFolders(['ls -la'], deps)).toEqual({ folders: [], unknown: false });
    // An input that could not be read to the end.
    expect(commandFolders(undefined, deps)).toEqual({ folders: [], unknown: true });
  });

  it('(b) catches a symlink alias with another name behind a visible cd (P4H-002)', () => {
    const behind = (commands: string[], value: string): boolean => {
      const found = commandFolders(commands, deps);
      return run(value, { ...wild, commandFolders: found.folders, foldersUnknown: found.unknown });
    };
    expect(behind(['cd src && cat abs-alias.txt'], 'cd src && cat abs-alias.txt')).toBe(true);
    // The cd was an earlier call (Copilot Chat's terminal keeps its folder).
    expect(behind(['cd src', 'cat abs-alias.txt'], 'cat abs-alias.txt')).toBe(true);
    expect(behind(["cd 'sp ace'", 'cat alias.txt'], 'cat alias.txt')).toBe(true);
    // The documented residual: the folder was entered outside the conversation.
    expect(run('cat abs-alias.txt', wild)).toBe(false);
    // A value that is not a command line is relative to the roots only.
    const found = commandFolders(['cd src'], deps);
    expect(
      isExcludedToolValue('abs-alias.txt', { ...wild, commandFolders: found.folders }, false),
    ).toBe(false);
  });

  it('(b) counts every command line as excluded after a change of folder it cannot resolve', () => {
    for (const command of [
      'cd $D',
      'cd "$(git rev-parse --show-toplevel)"',
      'cd `pwd`',
      'cd',
      'cd && ls',
      'cd -',
      'cd ~/x',
      'cd sr*',
      'cd {a,b}',
      'pushd +1',
      'cd "unclosed',
      'chdir',
      'cd src lib',
    ]) {
      expect(commandFolders([command], deps), command).toEqual({ folders: [], unknown: true });
    }
    const found = commandFolders(['cd $D'], deps);
    expect(run('echo hi', { ...wild, foldersUnknown: found.unknown })).toBe(true);
  });

  it('(b) counts more than 32 folders as unknown', () => {
    const many = Array.from({ length: 33 }, (_, i) => `cd d${i}`);
    // Folders /r/d0 … /r/d32 exist, one level deep.
    const anyFolder = {
      roots: ['/r'],
      realpath: (path: string) => path,
      isDirectory: (path: string) => /^\/r\/d\d+$/.test(path),
    };
    expect(commandFolders(many.slice(0, 32), anyFolder).unknown).toBe(false);
    expect(commandFolders(many, anyFolder).unknown).toBe(true);
  });

  it('collects the command lines of the tool calls (by tool name or input key)', () => {
    expect(
      commandValues([
        { name: 'run_in_terminal', input: { command: 'cd src', explanation: 'go' } },
        { name: 'read_file', input: { path: 'cd x' } },
        { name: 'mcp_custom', input: { args: { cmd: 'cd y' } } },
      ]),
    ).toEqual(['cd src', 'go', 'cd y']);
    // Nested deeper than any tool schema: its changes of folder cannot be known.
    let nested: unknown = { command: 'cd src' };
    for (let i = 0; i < 40; i++) nested = { inner: nested };
    expect(commandValues([{ name: 'run_in_terminal', input: nested }])).toBeUndefined();
  });
});

describe('recursive searches and glob matches (inspection of the hardening loop)', () => {
  const run = (value: string, given: ToolInputDeps): boolean =>
    isExcludedToolValue(value, given, true);
  /** With the folder listings: a glob's matches are checked by their realpath. */
  let listed: ToolInputDeps;
  /** A complete list without any excluded file. */
  let none: ToolInputDeps;
  beforeAll(() => {
    none = { ...wild, excludedPaths: new Set<string>() };
    listed = {
      ...wild,
      readdir: (path) => {
        try {
          return readdirSync(path);
        } catch {
          return undefined;
        }
      },
    };
  });

  it('D6: a recursive search counts as one of the current folder, whatever it names', () => {
    // Each of these reaches the excluded files below an unknown current folder: the folder
    // arguments cannot be told from option values, patterns and redirections (P4H-I001,
    // P4H-RI001, P4H-RI002), so none of them is trusted.
    for (const value of [
      'grep -r K src',
      'grep -rn K src; grep -rn K',
      'grep -r src',
      'grep -r --include=src K',
      'grep -r --regexp src',
      'grep -r abc < src/input.txt',
      'grep --recursive K src',
      'grep -d recurse K src',
      'grep --directories=recurse K src',
      'rg -t ts K src',
      'rg K --ignore-file src',
      'git grep K -- src',
      "find src -name '*.ts'",
      'ls -R src',
      'tree src',
      'ls src && rg K src',
    ]) {
      expect(run(value, wild), value).toBe(true);
    }
    // Without an excluded file in the workspace there is nothing to reach.
    expect(run('grep -r K src', none)).toBe(false);
    expect(run('rg K', none)).toBe(false);
    // Not a recursive search.
    expect(run('grep -n K src/math.ts', wild)).toBe(false);
    expect(run('ls sec*', wild)).toBe(false);
  });

  it('joins a backslash-newline as the shell does (a line continuation)', () => {
    expect(run('cat .e\\\nnv', wild)).toBe(true);
    expect(run('cat "secrets/k\\\ney"', wild)).toBe(true);
    expect(run('grep -\\\nr K src', wild)).toBe(true);
  });

  it('detects recursive searches conservatively (automated security review of 6c473a5)', () => {
    for (const value of [
      'grep --rec K',
      'grep --recur K src',
      'grep --directories recurse K',
      'grep --dir=recurse K',
      'grep -drecurse K',
      'grep -nd recurse K',
      'egrep -r K',
      'fgrep -R K',
      'zgrep -r K',
      'rgrep K',
      'ugrep K',
      'ls --recursive',
      'ls --rec',
      'ls -laR',
      'ls -1R',
      'gls -R',
      'grep -5r K',
      'grep -0R K',
      'ggrep -r K',
      'pcre2grep -r K',
      'zstdgrep -r K',
      'gfind . -name x',
    ]) {
      expect(run(value, wild), value).toBe(true);
    }
    for (const value of [
      'grep -n K src/math.ts',
      'npm test | grep FAIL',
      'ls -la',
      'ls --reverse',
      'grep -i -- K src/math.ts',
    ]) {
      expect(run(value, wild), value).toBe(false);
    }
  });

  it('counts shell state set in the conversation as unknown (automated security review)', () => {
    for (const command of [
      "alias g='grep -r'",
      'function g { grep -r "$@"; }',
      'g() { grep -r "$@"; }',
      'export GREP_OPTIONS=-r',
      'GREP_OPTIONS=-r grep K',
      'X=1 alias g=ls',
      'builtin alias g=ls',
      'command alias g=ls',
      'g () { grep -r "$@"; }',
      'g() if true; then grep -r K; fi',
      'g() grep -r K',
      'eval "$(cat x)"',
      '\\alias g=ls',
      '"alias" g=ls',
      "al''ias g=ls",
      '"eval" x',
      'GREP_OPT""IONS=-r grep K',
      'GREP\\_OPTIONS=-r grep K',
      'env $V=-r grep K',
      'export ${V}=-r',
      '$c g=ls',
      '`echo alias` g=ls',
      'command $c g=ls',
      'GREP_OPT\\\nIONS=-r grep K',
      'ali\\\nas g=ls',
      'command -p $c g=ls',
      'time -p $c g=ls',
      'builtin -- $c g=ls',
      '{alias,} g=ls',
      '{ali,x}as g=ls',
      'export GREP_{OPTIONS,X}=-r',
      '{$c,x} g=ls',
      'time X=1 $c g=ls',
      'noglob X=1 $c g=ls',
      'command -p X=1 builtin $c g=ls',
      // A quoted pattern counts too: quotes cannot tell a pattern from a command word.
      "grep -n 'alias' src/math.ts",
    ]) {
      expect(commandFolders([command], deps).unknown, command).toBe(true);
    }
    for (const command of [
      'git config alias.co checkout',
      'grep -n "export function" src/math.ts',
      'python3 -c "print()"',
      'source .venv/bin/activate',
      'export PATH=$PATH:/opt/bin',
      'echo $HOME',
      'echo {a,b}',
      '{ ls; }',
      'nice -n 5 make test',
    ]) {
      expect(commandFolders([command], deps).unknown, command).toBe(false);
    }
  });

  it('P4H-I003: a glob that matches a symlink alias with another name', () => {
    expect(run('cat src/*', listed)).toBe(true);
    expect(run('cat src/*.txt', listed)).toBe(true);
    expect(run('cat l*/key', listed)).toBe(true);
    expect(run("cat 'sp ace'/*.txt", listed)).toBe(true);
    expect(run('cat src/*.ts', listed)).toBe(false);
    // A search tool's include pattern (not a command line).
    expect(isExcludedToolValue('src/*', listed)).toBe(true);
    expect(isExcludedToolValue('{x,src}/a*', listed)).toBe(true);
    expect(isExcludedToolValue('src/*.ts', listed)).toBe(false);
    // `**` is not listed (the documented residual): only the excluded files' paths are matched.
    expect(isExcludedToolValue('src/**/*.txt', listed)).toBe(false);
  });

  it('P4H-I003: too many entries to list count as excluded', () => {
    const crowded: ToolInputDeps = {
      ...wild,
      readdir: () => Array.from({ length: 5000 }, (_, i) => `f${i}`),
    };
    expect(run('cat src/*.ts', crowded)).toBe(true);
  });
});
