// The red-team cases of the chat exclusion filters (docs/plans/phase-2-review.md, "Red-team pass",
// and docs/plans/phase-2-hardening-review.md, P6), run against real files in a temporary
// workspace. The oracle mirrors `isExcludedPath` in src/extension.ts without VS Code: the
// workspace-relative path (the absolute one outside the workspace), the existence rule, realpath,
// and diff paths under every repository root. The content net is built from the workspace files
// that match the patterns, as `ExcludedContentIndex` does.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isExcluded, platformExcludeOptions } from '../../src/core/context/exclude';
import { buildExcludedContent } from '../../src/features/chat/contentGuard';
import { toCliPrompt, type ChatTurn, type PathKind } from '../../src/features/chat/messages';

interface RedTeamCase {
  name: string;
  patterns?: string[];
  /** Git repository roots, relative to the workspace ('' is the workspace itself). */
  repoRoots?: string[];
  workspaceFiles: Record<string, string>;
  /** Link path → target, both relative to the workspace. */
  symlinks?: Record<string, string>;
  /** `{{WS}}` stands for the workspace root. */
  turns: ChatTurn[];
  secret: string[];
  keep: string[];
  /** Keeps that are removed by a documented cost (measured on darwin). */
  lost?: string[];
  lostBecause?: string;
  /** Platforms that can hold the case's files or need its matching rules. */
  platforms?: NodeJS.Platform[];
}

const DIR = join(__dirname, '..', 'fixtures', 'redteam');
const cases = readdirSync(DIR)
  .filter((file) => file.endsWith('.json'))
  .sort()
  .map((file) => [file.slice(0, -5), JSON.parse(readFileSync(join(DIR, file), 'utf8'))] as const)
  .map(([id, spec]) => [id, spec as RedTeamCase] as const);

function run(spec: RedTeamCase): string {
  const ws = realpathSync(mkdtempSync(join(tmpdir(), 'mp-redteam-')));
  try {
    for (const [path, content] of Object.entries(spec.workspaceFiles)) {
      mkdirSync(dirname(join(ws, path)), { recursive: true });
      writeFileSync(join(ws, path), content);
    }
    for (const [link, target] of Object.entries(spec.symlinks ?? {})) {
      mkdirSync(dirname(join(ws, link)), { recursive: true });
      symlinkSync(target, join(ws, link));
    }
    const patterns = spec.patterns ?? ['.env*', '*.pem', 'secrets/**'];
    const options = platformExcludeOptions();
    const relative = (path: string): string =>
      path.startsWith(`${ws}/`) ? path.slice(ws.length + 1) : path;
    const matches = (candidate: string): boolean =>
      isExcluded(relative(candidate), patterns, options);
    const oracle = (path: string, kind: PathKind): boolean => {
      if (matches(path)) return true;
      if (isAbsolute(path)) {
        if (!existsSync(path)) return kind !== 'element';
        try {
          const real = realpathSync(path);
          return real !== path && matches(real);
        } catch {
          return true;
        }
      }
      if (kind !== 'diff') return false;
      return (spec.repoRoots ?? ['']).some((root) => matches(join(ws, root, path)));
    };
    const guard = buildExcludedContent(
      Object.entries(spec.workspaceFiles)
        .filter(([path]) => matches(join(ws, path)))
        .map(([path, text]) => ({ path: join(ws, path), text })),
      options,
    );
    const turns = spec.turns.map((turn) => ({ ...turn, text: turn.text.replaceAll('{{WS}}', ws) }));
    const { system, prompt } = toCliPrompt(turns, oracle, guard);
    return `${system}\n${prompt}`;
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

describe('red-team cases (test/fixtures/redteam)', () => {
  it('has the cases', () => {
    expect(cases.length).toBeGreaterThanOrEqual(39);
  });

  it.each(cases)('%s', (_id, spec) => {
    if (spec.platforms && !spec.platforms.includes(process.platform)) return;
    const sent = run(spec);
    expect(spec.secret.filter((secret) => sent.includes(secret))).toEqual([]);
    const missing = spec.keep.filter((keep) => !sent.includes(keep));
    // The documented over-redaction was measured on darwin; elsewhere it may only be smaller.
    if (process.platform === 'darwin') expect(missing).toEqual(spec.lost ?? []);
    else expect(missing.filter((keep) => !(spec.lost ?? []).includes(keep))).toEqual([]);
  });
});
