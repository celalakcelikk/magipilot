// OutputChannel log (AGENTS.md rule 7): meta information only — backend, duration, character
// counts, outcome. Prompt or completion content is written only when `magipilot.log.debugContent`
// is on, through `content()`.
import * as vscode from 'vscode';

export type Meta = Record<string, string | number | boolean | undefined>;

function format(event: string, meta: Meta): string {
  const fields = Object.entries(meta)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
  return [event, ...fields].join(' ');
}

export class Log implements vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel('Magipilot', { log: true });

  constructor(private readonly debugContent: () => boolean) {}

  info(event: string, meta: Meta = {}): void {
    this.channel.info(format(event, meta));
  }

  warn(event: string, meta: Meta = {}): void {
    this.channel.warn(format(event, meta));
  }

  /** `detail` is an error message from a backend or the runtime, never prompt content. */
  error(event: string, detail: string, meta: Meta = {}): void {
    this.channel.error(`${format(event, meta)} — ${detail}`);
  }

  content(label: string, text: string): void {
    if (this.debugContent()) this.channel.debug(`${label}:\n${text}`);
  }

  show(): void {
    this.channel.show(true);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
