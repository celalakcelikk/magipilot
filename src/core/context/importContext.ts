// Signatures of the files a document imports (docs/plans/phase-3-context.md AC1–AC3b, C5). Pure:
// the file system comes in through `ImportFs`, so the safety rules run under unit tests.
// - A file is read only if its folder-relative path and its real path (relative to the folder's
//   real path) are both inside the workspace folder and both pass `magipilot.exclude`; if a
//   `realpath` fails the file is skipped (AGENTS rule 6, fail closed).
// - Caps: import statements, files, file size, characters; a deadline; the caller's abort signal.
// - The state each file was read in is returned, so a cached completion can check it is current.
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { isExcluded, type ExcludeOptions } from './exclude';
import {
  candidatePaths,
  importLanguage,
  parseImports,
  type ImportLanguage,
  type Wanted,
} from './imports';
import { extractDeclarations, renderDeclarations, type Declaration } from './signatures';

export interface FileState {
  size: number;
  mtimeMs: number;
  isFile: boolean;
}

export interface OpenDocument {
  uri: string;
  version: number;
  text: string;
  isDirty: boolean;
}

/** Absolute OS paths throughout. */
export interface ImportFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<FileState>;
  readFile(path: string): Promise<string>;
  /** An open editor's document for this path (unsaved edits included), if any. */
  openDocument(path: string): OpenDocument | undefined;
}

/** How a dependency was read, to tell later whether it is still the same. */
export type DependencyState =
  | { kind: 'document'; path: string; realPath: string; uri: string; version: number }
  | { kind: 'file'; path: string; realPath: string; size: number; mtimeMs: number };

export interface ImportSnippet {
  /** Folder-relative POSIX path, as the document imports it. */
  path: string;
  text: string;
}

export interface ImportContextInput {
  languageId: string;
  documentText: string;
  /** Absolute paths of the document and of its workspace folder. */
  documentPath: string;
  folderPath: string;
  exclude: readonly string[];
  excludeOptions: ExcludeOptions;
  signal?: AbortSignal;
}

export interface ImportContextOptions {
  maxImports: number;
  maxFiles: number;
  maxCharsPerFile: number;
  maxFileBytes: number;
  deadlineMs: number;
  /** Deadline for checking a cached completion's dependencies (CTX-R004). */
  dependencyCheckMs: number;
  /** Extracted declarations kept between requests. */
  cacheEntries: number;
}

export const DEFAULT_IMPORT_OPTIONS: ImportContextOptions = {
  maxImports: 20,
  maxFiles: 3,
  maxCharsPerFile: 600,
  maxFileBytes: 256 * 1024,
  deadlineMs: 100,
  dependencyCheckMs: 50,
  cacheEntries: 50,
};

export interface ImportContextResult {
  snippets: ImportSnippet[];
  dependencies: DependencyState[];
  /** `error`: an unexpected failure while gathering; the request goes on without signatures. */
  outcome: 'ok' | 'deadline' | 'aborted' | 'error';
}

export type DependencyCheck = 'current' | 'stale' | 'deadline' | 'aborted';

const EMPTY: ImportContextResult = { snippets: [], dependencies: [], outcome: 'ok' };

/** A folder-relative POSIX path, or undefined when `path` is not inside `folder`. */
function folderRelative(folder: string, path: string): string | undefined {
  const rel = relative(folder, path);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
  return rel.split(sep).join('/');
}

/** A directory relative to the folder ('' for the folder itself), or undefined outside it. */
function folderDirectory(folder: string, dir: string): string | undefined {
  return relative(folder, dir) === '' ? '' : folderRelative(folder, dir);
}

/** Resolves when `signal` aborts, or never. */
function aborted(signal: AbortSignal | undefined): Promise<'aborted'> {
  return new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve('aborted');
    else signal.addEventListener('abort', () => resolve('aborted'), { once: true });
  });
}

/**
 * Runs `work` until it ends, the deadline passes or the signal aborts. `work` receives a check
 * that tells it to stop early once the outcome is decided.
 */
async function bounded<T>(
  work: (stopped: () => boolean) => Promise<T>,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<T | 'deadline' | 'aborted'> {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<'deadline'>((resolve) => {
    timer = setTimeout(() => resolve('deadline'), deadlineMs);
  });
  try {
    return await Promise.race([
      work(() => done || signal?.aborted === true),
      deadline,
      aborted(signal),
    ]);
  } finally {
    done = true;
    clearTimeout(timer);
  }
}

function mergeWanted(a: Wanted, b: Wanted): Wanted {
  if (a.names === undefined || b.names === undefined) return {};
  return {
    names: [...new Set([...a.names, ...b.names])],
    default: a.default === true || b.default === true,
  };
}

interface Resolved {
  path: string;
  absolute: string;
  realPath: string;
  state: FileState;
  wanted: Wanted;
}

export class ImportContext {
  /** Declarations per file state (real path and size/mtime, or URI and version). */
  private readonly declarations = new Map<string, Declaration[]>();

  constructor(
    private readonly fs: ImportFs,
    private readonly options: ImportContextOptions = DEFAULT_IMPORT_OPTIONS,
  ) {}

  async collect(input: ImportContextInput): Promise<ImportContextResult> {
    const language = importLanguage(input.languageId);
    if (!language) return EMPTY;
    const result = await bounded(
      // A bug in the heuristics must never fail the inline request: no signatures instead.
      (stopped) =>
        this.gather(input, language, stopped).catch((): ImportContextResult => ({
          snippets: [],
          dependencies: [],
          outcome: 'error',
        })),
      this.options.deadlineMs,
      input.signal,
    );
    if (result === 'deadline' || result === 'aborted') {
      return { snippets: [], dependencies: [], outcome: result };
    }
    return result;
  }

  private async gather(
    input: ImportContextInput,
    language: ImportLanguage,
    stopped: () => boolean,
  ): Promise<ImportContextResult> {
    const fromDir = folderDirectory(input.folderPath, dirname(input.documentPath));
    if (fromDir === undefined) return EMPTY;
    let folderReal: string;
    let documentReal: string | undefined;
    try {
      folderReal = await this.fs.realpath(input.folderPath);
      documentReal = await this.fs.realpath(input.documentPath).catch(() => undefined);
    } catch {
      return EMPTY; // no real folder to compare with: read nothing
    }
    const refs = parseImports(input.documentText, language, this.options.maxImports);
    const byReal = new Map<string, Resolved>();
    for (const ref of refs) {
      if (stopped()) return EMPTY;
      const resolved = await this.resolve(ref.specifier, language, fromDir, input, folderReal);
      if (!resolved || resolved.realPath === documentReal) continue;
      const known = byReal.get(resolved.realPath);
      if (known) known.wanted = mergeWanted(known.wanted, ref.wanted);
      else byReal.set(resolved.realPath, { ...resolved, wanted: ref.wanted });
    }
    const snippets: ImportSnippet[] = [];
    const dependencies: DependencyState[] = [];
    for (const file of byReal.values()) {
      if (snippets.length >= this.options.maxFiles || stopped()) break;
      const read = await this.read(file, language);
      if (!read) continue;
      const text = renderDeclarations(
        read.declarations,
        file.wanted,
        language,
        this.options.maxCharsPerFile,
      );
      if (text === '') continue;
      snippets.push({ path: file.path, text });
      dependencies.push(read.state);
    }
    return { snippets, dependencies, outcome: 'ok' };
  }

  /** The first existing candidate of a specifier, if it passes every rule; otherwise undefined. */
  private async resolve(
    specifier: string,
    language: ImportLanguage,
    fromDir: string,
    input: ImportContextInput,
    folderReal: string,
  ): Promise<Omit<Resolved, 'wanted'> | undefined> {
    for (const path of candidatePaths(language, specifier, fromDir)) {
      const absolute = join(input.folderPath, ...path.split('/'));
      const state = await this.fs.stat(absolute).catch(() => undefined);
      if (!state) continue;
      // The first existing candidate is what the import names: no fallback to another file.
      if (!state.isFile || state.size > this.options.maxFileBytes) return undefined;
      if (isExcluded(path, input.exclude, input.excludeOptions)) return undefined;
      const realPath = await this.fs.realpath(absolute).catch(() => undefined);
      if (realPath === undefined) return undefined;
      const realRelative = folderRelative(folderReal, realPath);
      if (realRelative === undefined) return undefined;
      if (isExcluded(realRelative, input.exclude, input.excludeOptions)) return undefined;
      return { path, absolute, realPath, state };
    }
    return undefined;
  }

  private async read(
    file: Resolved,
    language: ImportLanguage,
  ): Promise<{ declarations: Declaration[]; state: DependencyState } | undefined> {
    // Unsaved edits are read from the editor (of either path, CTX-I008); otherwise the disk is
    // the truth, also for an open document (a hidden editor model may lag behind the disk).
    const open = this.editors(file.absolute, file.realPath).find((editor) => editor.isDirty);
    if (open) {
      if (Buffer.byteLength(open.text, 'utf8') > this.options.maxFileBytes) return undefined;
      const key = `doc\u0000${open.uri}\u0000${open.version}\u0000${language}`;
      return {
        declarations: this.extract(key, language, () => open.text),
        state: {
          kind: 'document',
          path: file.absolute,
          realPath: file.realPath,
          uri: open.uri,
          version: open.version,
        },
      };
    }
    const key = `file\u0000${file.realPath}\u0000${file.state.size}\u0000${file.state.mtimeMs}\u0000${language}`;
    let text: string | undefined;
    if (!this.declarations.has(key)) {
      text = await this.fs.readFile(file.realPath).catch(() => undefined);
      if (text === undefined) return undefined;
    }
    return {
      declarations: this.extract(key, language, () => text!),
      state: {
        kind: 'file',
        path: file.absolute,
        realPath: file.realPath,
        size: file.state.size,
        mtimeMs: file.state.mtimeMs,
      },
    };
  }

  private extract(key: string, language: ImportLanguage, text: () => string): Declaration[] {
    const known = this.declarations.get(key);
    if (known) {
      this.declarations.delete(key);
      this.declarations.set(key, known);
      return known;
    }
    const declarations = extractDeclarations(language, text());
    this.declarations.set(key, declarations);
    while (this.declarations.size > this.options.cacheEntries) {
      this.declarations.delete(this.declarations.keys().next().value as string);
    }
    return declarations;
  }

  /** The open documents of a file under its path and its real path (a symlink and its target). */
  private editors(path: string, realPath: string): OpenDocument[] {
    const found = [this.fs.openDocument(path), this.fs.openDocument(realPath)].filter(
      (editor): editor is OpenDocument => editor !== undefined,
    );
    return found.filter((editor, i) => found.findIndex((e) => e.uri === editor.uri) === i);
  }

  /**
   * Synchronous: the editors of a dependency are as they were. A document read with unsaved edits
   * is still open in the same version, and no other editor of the file has unsaved edits; a file
   * read from disk has no editor with unsaved edits (CTX-I005, CTX-I008).
   */
  private editorsCurrent(dependency: DependencyState): boolean {
    const editors = this.editors(dependency.path, dependency.realPath);
    if (dependency.kind === 'document') {
      return (
        editors.some((e) => e.uri === dependency.uri && e.version === dependency.version) &&
        !editors.some((e) => e.uri !== dependency.uri && e.isDirty)
      );
    }
    return !editors.some((e) => e.isDirty);
  }

  /**
   * Whether every dependency is still in the state it was read in (CTX-R002–R004): a document
   * read with unsaved edits still open with the same version; or a file that is not open with
   * unsaved edits, still resolves to the same real path and has the same size and mtime.
   * Asynchronous, under a deadline.
   */
  async dependenciesCurrent(
    dependencies: readonly DependencyState[],
    signal?: AbortSignal,
    deadlineMs = this.options.dependencyCheckMs,
  ): Promise<DependencyCheck> {
    if (dependencies.length === 0) return 'current';
    const result = await bounded(
      async (stopped) => {
        for (const dependency of dependencies) {
          if (stopped()) return 'stale' as const;
          if (!this.editorsCurrent(dependency)) return 'stale';
          if (dependency.kind === 'document') continue;
          const realPath = await this.fs.realpath(dependency.path).catch(() => undefined);
          if (realPath !== dependency.realPath) return 'stale';
          const state = await this.fs.stat(dependency.realPath).catch(() => undefined);
          if (!state || state.size !== dependency.size || state.mtimeMs !== dependency.mtimeMs)
            return 'stale';
        }
        // An editor may have changed while the file system was awaited (CTX-I005).
        return dependencies.every((d) => this.editorsCurrent(d))
          ? ('current' as const)
          : ('stale' as const);
      },
      deadlineMs,
      signal,
    ).catch(() => 'stale' as const);
    return result;
  }
}
