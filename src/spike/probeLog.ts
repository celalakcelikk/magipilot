import { appendFileSync } from 'node:fs';
import * as vscode from 'vscode';
import type { ProbeRecord } from './probeRecord';

/** Writes metadata-only probe records to the "Magipilot" output channel and an optional file. */
export class ProbeLog implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('Magipilot');

  constructor(private readonly filePath: string | undefined) {}

  write(record: ProbeRecord): void {
    this.channel.appendLine(`[probe] ${JSON.stringify(record)}`);
    if (this.filePath) {
      appendFileSync(this.filePath, `${JSON.stringify(record)}\n`);
    }
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
