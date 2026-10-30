// `Magipilot: Show Stats` (docs/plans/phase-3-metrics.md M1): one webview panel without scripts,
// re-rendered every 2 s while it is visible.
import * as vscode from 'vscode';
import type { BackendStats, ChatModelStats } from '../metrics';
import { renderStatsHtml } from './statsHtml';

export interface StatsSources {
  inline: () => Record<string, BackendStats>;
  chat: () => Record<string, ChatModelStats>;
}

const REFRESH_MS = 2000;

export class StatsPanel implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly sources: StatsSources) {}

  /** The panel's current HTML (test API), or undefined while it is closed. */
  get html(): string | undefined {
    return this.panel?.webview.html;
  }

  show(): void {
    if (this.panel) {
      this.render();
      this.panel.reveal();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'magipilot.stats',
      'Magipilot Stats',
      vscode.ViewColumn.Active,
      { enableScripts: false, enableCommandUris: false, localResourceRoots: [] },
    );
    this.panel = panel;
    panel.onDidDispose(() => {
      this.stopTimer();
      this.panel = undefined;
    });
    this.render();
    this.timer = setInterval(() => {
      if (this.panel?.visible) this.render();
    }, REFRESH_MS);
  }

  /** Re-renders an open panel at once (after a reset). */
  refresh(): void {
    if (this.panel) this.render();
  }

  private render(): void {
    if (!this.panel) return;
    const html = renderStatsHtml({
      inline: this.sources.inline(),
      chat: this.sources.chat(),
      cspSource: this.panel.webview.cspSource,
    });
    // Assigning the same HTML again would reload the page for nothing.
    if (this.panel.webview.html !== html) this.panel.webview.html = html;
  }

  private stopTimer(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.stopTimer();
    this.panel?.dispose();
    this.panel = undefined;
  }
}
