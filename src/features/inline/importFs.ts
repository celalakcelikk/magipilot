// The file system behind import signatures (docs/plans/phase-3-context.md C5): Node's file
// system for `file` paths, and the open editors' text, unsaved edits included.
import { promises as fs } from 'node:fs';
import * as vscode from 'vscode';
import type { FileState, ImportFs, OpenDocument } from '../../core/context/importContext';

// Paths compare case-insensitively where the default file system does (as magipilot.exclude).
const foldCase = process.platform === 'darwin' || process.platform === 'win32';

function samePath(a: string, b: string): boolean {
  return foldCase ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export class NodeImportFs implements ImportFs {
  /** Test only (MAGIPILOT_TEST): every operation waits this long, to hold a gathering open. */
  delayMs = 0;

  private async pause(): Promise<void> {
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
  }

  async realpath(path: string): Promise<string> {
    await this.pause();
    return fs.realpath(path);
  }

  async stat(path: string): Promise<FileState> {
    await this.pause();
    const stats = await fs.stat(path);
    return { size: stats.size, mtimeMs: stats.mtimeMs, isFile: stats.isFile() };
  }

  async readFile(path: string): Promise<string> {
    await this.pause();
    return fs.readFile(path, 'utf8');
  }

  openDocument(path: string): OpenDocument | undefined {
    const document = vscode.workspace.textDocuments.find(
      (doc) => doc.uri.scheme === 'file' && samePath(doc.uri.fsPath, path),
    );
    if (!document) return undefined;
    return {
      uri: document.uri.toString(),
      version: document.version,
      text: document.getText(),
      isDirty: document.isDirty,
    };
  }
}
