// Similar code from other open documents of the same language (PLAN §6.3). Callers must pass only
// documents that are not excluded; `selectSnippets` filters again so an excluded file can never
// reach a prompt (AGENTS.md rule 6).
import { isExcluded, platformExcludeOptions } from './exclude';

export interface SnippetSource {
  path: string;
  text: string;
}

export interface Snippet {
  path: string;
  text: string;
}

export interface SnippetOptions {
  maxSnippets: number;
  maxChars: number;
  windowLines: number;
  minScore: number;
  exclude: readonly string[];
}

export const DEFAULT_SNIPPET_OPTIONS: SnippetOptions = {
  maxSnippets: 3,
  maxChars: 600,
  windowLines: 20,
  minScore: 0.1,
  exclude: [],
};

// Keywords common to most languages say nothing about similarity.
const STOPWORDS = new Set([
  'const',
  'let',
  'var',
  'function',
  'return',
  'else',
  'for',
  'while',
  'import',
  'export',
  'from',
  'def',
  'class',
  'self',
  'this',
  'new',
  'true',
  'false',
  'null',
  'None',
  'True',
  'False',
  'and',
  'not',
  'async',
  'await',
  'public',
  'private',
  'static',
  'void',
  'func',
  'package',
  'pub',
  'impl',
  'mut',
  'type',
  'interface',
  'string',
  'number',
  'int',
]);

function tokens(text: string): Set<string> {
  return new Set((text.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) ?? []).filter((t) => !STOPWORDS.has(t)));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared);
}

/**
 * Import signatures first, then the similar windows of the files that gave none: a path appears
 * once (docs/plans/phase-3-context.md C3).
 */
export function mergeSnippets(
  signatures: readonly Snippet[],
  similar: readonly Snippet[],
): Snippet[] {
  const paths = new Set(signatures.map((snippet) => snippet.path));
  return [...signatures, ...similar.filter((snippet) => !paths.has(snippet.path))];
}

export function selectSnippets(
  prefix: string,
  sources: readonly SnippetSource[],
  options: Partial<SnippetOptions> = {},
): Snippet[] {
  const opts = { ...DEFAULT_SNIPPET_OPTIONS, ...options };
  const query = tokens(prefix.split('\n').slice(-opts.windowLines).join('\n'));
  const scored: { score: number; snippet: Snippet }[] = [];
  for (const source of sources) {
    if (isExcluded(source.path, opts.exclude, platformExcludeOptions())) continue;
    const lines = source.text.split('\n');
    const step = Math.max(1, Math.floor(opts.windowLines / 2));
    let best: { score: number; text: string } | undefined;
    for (let start = 0; start < Math.max(1, lines.length - step); start += step) {
      const text = lines.slice(start, start + opts.windowLines).join('\n');
      const score = jaccard(query, tokens(text));
      if (!best || score > best.score) best = { score, text };
    }
    if (best && best.score >= opts.minScore) {
      scored.push({
        score: best.score,
        snippet: { path: source.path, text: best.text.slice(0, opts.maxChars) },
      });
    }
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.maxSnippets)
    .map((entry) => entry.snippet);
}
