// Index of excluded workspace files for the chat content net (docs/plans/phase-2-hardening.md §3).
// Files matching `magipilot.exclude` are read only inside the extension host; their lines and
// names are never logged or sent anywhere.
import { constants } from 'node:fs';
import { open, stat } from 'node:fs/promises';
import * as vscode from 'vscode';
import { discoveryGlobs } from '../../core/context/discovery';
import { isExcluded, type ExcludeOptions } from '../../core/context/exclude';
import type { Log } from '../../ui/log';
import {
  buildExcludedContent,
  decodeText,
  discoverExcluded,
  planIndexReads,
  type ExcludedContent,
} from './contentGuard';
import { IndexCache } from './indexCache';

/** Without a watcher event the index is rebuilt after this long anyway. */
const TTL_MS = 60_000;

export interface ExcludedIndexDeps {
  patterns(): string[];
  options(): ExcludeOptions;
  log: Log;
  /** The index does not cover every excluded file (a cap was reached). */
  onTruncated?(): void;
}

/**
 * The first `bytes` of a regular file, or undefined for anything else (a FIFO, a device, a
 * socket, also behind a symlink). `O_NONBLOCK` keeps open() from waiting for a FIFO's writer,
 * which would stall every chat request; it does not change reads of a regular file.
 */
async function readHead(path: string, bytes: number): Promise<Buffer | undefined> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await file.stat()).isFile()) return undefined;
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await file.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}

export class ExcludedContentIndex implements vscode.Disposable {
  private readonly cache = new IndexCache(() => this.build(), TTL_MS);
  private watchedKey = '';
  private watchers: vscode.Disposable[] = [];

  constructor(private readonly deps: ExcludedIndexDeps) {}

  /**
   * The current index, built on first use and after a change (at most TTL_MS old). Never a
   * build that started before the last invalidate().
   */
  get(): Promise<ExcludedContent> {
    return this.cache.get();
  }

  /** Settings or workspace folders changed: get() waits for a build that starts after this. */
  invalidate(): void {
    this.cache.invalidate();
  }

  private async build(): Promise<ExcludedContent> {
    const startedAt = Date.now();
    const patterns = this.deps.patterns();
    const options = this.deps.options();
    const globs = discoveryGlobs(patterns, options);
    const folders = vscode.workspace.workspaceFolders ?? [];
    this.watch(folders, globs);

    // Discovery globs find a superset (H7, HARD-R001); the oracle's own matching decides, on the
    // workspace-relative path as in extension.ts (HARD-I002), before any file cap (HARD-I003).
    const discovered = await discoverExcluded(
      folders.flatMap((folder) =>
        globs.map(
          (glob) => (max: number) =>
            // `null`: files.exclude must not hide files from the index (HARD-R002).
            vscode.workspace.findFiles(new vscode.RelativePattern(folder, glob), null, max),
        ),
      ),
      (uri) =>
        uri.scheme === 'file' &&
        isExcluded(vscode.workspace.asRelativePath(uri, false), patterns, options),
    );
    const found = new Set(discovered.found.map((uri) => uri.fsPath));
    const discoveryCut = discovered.cut;

    const sized: { path: string; size: number }[] = [];
    // A FIFO, a device or a socket is never read; like a binary file, it adds only its name.
    const files: { path: string; text?: string }[] = [];
    let unreadable = 0;
    for (const path of found) {
      try {
        const stats = await stat(path);
        if (stats.isFile()) sized.push({ path, size: stats.size });
        else files.push({ path });
      } catch {
        unreadable++;
      }
    }
    const plan = planIndexReads(sized);
    let bytes = 0;
    for (const read of plan.reads) {
      try {
        const head = await readHead(read.path, read.bytes);
        if (head === undefined) {
          // Replaced by a special file since stat().
          files.push({ path: read.path });
          continue;
        }
        bytes += head.length;
        // UTF-16 files are decoded by their byte order mark; other heads with a NUL are binary
        // and add only their name.
        const text = decodeText(head);
        files.push(text === undefined ? { path: read.path } : { path: read.path, text });
      } catch {
        unreadable++;
      }
    }
    // Every discovered path, read or not, for the tool-input checks (phase-4-tools.md T8).
    const content = buildExcludedContent(files, options, {
      paths: found,
      complete: !discoveryCut,
    });
    const truncated = plan.truncated || discoveryCut;
    // Meta only (AGENTS rule 7): never a path or a line.
    this.deps.log.info('exclude index', {
      files: files.length,
      lines: content.lines.size,
      bytes,
      ms: Date.now() - startedAt,
      truncated,
      discoveryCut,
      unreadable,
    });
    if (truncated) this.deps.onTruncated?.();
    return content;
  }

  /** Watches the discovery globs; any event drops the cached index. */
  private watch(folders: readonly vscode.WorkspaceFolder[], globs: readonly string[]): void {
    const key = JSON.stringify([folders.map((folder) => folder.uri.toString()), globs]);
    if (key === this.watchedKey) return;
    this.disposeWatchers();
    this.watchedKey = key;
    const drop = (): void => this.cache.drop();
    for (const folder of folders) {
      for (const glob of globs) {
        const watcher = vscode.workspace.createFileSystemWatcher(
          new vscode.RelativePattern(folder, glob),
        );
        this.watchers.push(
          watcher,
          watcher.onDidCreate(drop),
          watcher.onDidChange(drop),
          watcher.onDidDelete(drop),
        );
      }
    }
  }

  private disposeWatchers(): void {
    for (const watcher of this.watchers) watcher.dispose();
    this.watchers = [];
    this.watchedKey = '';
  }

  dispose(): void {
    this.disposeWatchers();
    this.invalidate();
  }
}
