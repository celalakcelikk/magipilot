// Completion cache with "typing through" continuation (PLAN §6.4; docs/plans/phase-1.md §4.4,
// reviews P1-R003, P1-R005, P1-R006). Works on the whole document text, not on the bounded
// prefix, so it behaves the same beyond maxPrefixChars.
import { createHash } from 'node:crypto';
import type { DependencyState } from './context/importContext';

export const ANCHOR_CONTEXT_CHARS = 256;
/** Entries kept (LRU); docs/bench.md checks it against the simulated working set. */
export const CACHE_CAPACITY = 100;

export interface CacheEntry {
  documentUri: string;
  backendGeneration: number;
  anchorOffset: number;
  anchorHash: string;
  /** Size of the suffix window the request was built with (magipilot.inline.maxSuffixChars). */
  suffixChars: number;
  suffixHead: string;
  completion: string;
  /** Backend that produced the completion (acceptance attribution, P1-I012). */
  backend: string;
  /**
   * Files whose signatures the request carried, in the state they were read in; the caller checks
   * them before using a hit (docs/plans/phase-3-context.md AC3b).
   */
  dependencies: readonly DependencyState[];
}

export interface CacheHit {
  text: string;
  backend: string;
  dependencies: readonly DependencyState[];
  /** Identifies the entry for drop(). */
  key: string;
}

export interface CacheQuery {
  documentUri: string;
  documentText: string;
  cursorOffset: number;
  backendGeneration: number;
  /** The configured suffix limit: the whole window the model saw must be unchanged (P1-I005). */
  suffixChars: number;
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function anchorHashAt(text: string, offset: number): string {
  return hash(text.slice(Math.max(0, offset - ANCHOR_CONTEXT_CHARS), offset));
}

function suffixAt(text: string, offset: number, chars: number): string {
  return text.slice(offset, offset + chars);
}

export class CompletionCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly capacity = CACHE_CAPACITY) {}

  get size(): number {
    return this.entries.size;
  }

  private key(
    entry: Pick<CacheEntry, 'documentUri' | 'backendGeneration' | 'anchorOffset' | 'anchorHash'>,
  ): string {
    return `${entry.documentUri}\u0000${entry.backendGeneration}\u0000${entry.anchorOffset}\u0000${entry.anchorHash}`;
  }

  store(
    query: CacheQuery,
    completion: string,
    backend: string,
    dependencies: readonly DependencyState[] = [],
  ): void {
    const entry: CacheEntry = {
      documentUri: query.documentUri,
      backendGeneration: query.backendGeneration,
      anchorOffset: query.cursorOffset,
      anchorHash: anchorHashAt(query.documentText, query.cursorOffset),
      suffixChars: query.suffixChars,
      suffixHead: suffixAt(query.documentText, query.cursorOffset, query.suffixChars),
      completion,
      backend,
      dependencies,
    };
    const key = this.key(entry);
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next().value as string;
      this.entries.delete(oldest);
    }
  }

  /**
   * The text to show at the cursor, or undefined. Every hit validates the whole context first:
   * same document and backend generation, unchanged text before the anchor, and the text after
   * the cursor exactly equal to the stored suffix head (P1-R006).
   */
  lookup(query: CacheQuery): CacheHit | undefined {
    for (const [key, entry] of [...this.entries].reverse()) {
      if (entry.documentUri !== query.documentUri) continue;
      if (entry.backendGeneration !== query.backendGeneration) continue;
      if (query.cursorOffset < entry.anchorOffset) continue;
      if (entry.suffixChars !== query.suffixChars) continue;
      if (anchorHashAt(query.documentText, entry.anchorOffset) !== entry.anchorHash) continue;
      const suffix = suffixAt(query.documentText, query.cursorOffset, entry.suffixChars);
      if (suffix !== entry.suffixHead) continue;
      const typed = query.documentText.slice(entry.anchorOffset, query.cursorOffset);
      if (typed === '') {
        this.touch(key, entry);
        return {
          text: entry.completion,
          backend: entry.backend,
          dependencies: entry.dependencies,
          key,
        };
      }
      if (typed.length < entry.completion.length && entry.completion.startsWith(typed)) {
        this.touch(key, entry);
        return {
          text: entry.completion.slice(typed.length),
          backend: entry.backend,
          dependencies: entry.dependencies,
          key,
        };
      }
    }
    return undefined;
  }

  clear(): void {
    this.entries.clear();
  }

  /** Removes the entry of a hit whose dependencies are stale. */
  drop(hit: CacheHit): void {
    this.entries.delete(hit.key);
  }

  /** Removes every entry made with signatures: an import may now resolve to another file. */
  dropWithDependencies(): void {
    for (const [key, entry] of [...this.entries]) {
      if (entry.dependencies.length > 0) this.entries.delete(key);
    }
  }

  private touch(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }
}
