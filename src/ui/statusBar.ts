// Status bar item: shows whether inline completion is on, busy or failing; a click toggles it.
import * as vscode from 'vscode';

export type InlineState =
  | { kind: 'enabled'; backend: string }
  | { kind: 'disabled' }
  | { kind: 'busy'; backend: string }
  | { kind: 'error'; backend: string; message: string };

export class StatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private current: InlineState = { kind: 'disabled' };

  constructor(toggleCommand: string) {
    this.item.name = 'Magipilot';
    this.item.command = toggleCommand;
    this.render();
    this.item.show();
  }

  get state(): InlineState {
    return this.current;
  }

  set(state: InlineState): void {
    this.current = state;
    this.render();
  }

  private render(): void {
    const state = this.current;
    this.item.backgroundColor = undefined;
    switch (state.kind) {
      case 'enabled':
        this.item.text = '$(wand) Magipilot';
        this.item.tooltip = `Inline completion on (${state.backend}). Click to turn off.`;
        break;
      case 'disabled':
        this.item.text = '$(circle-slash) Magipilot';
        this.item.tooltip = 'Inline completion off. Click to turn on.';
        break;
      case 'busy':
        this.item.text = '$(loading~spin) Magipilot';
        this.item.tooltip = `Waiting for ${state.backend}…`;
        break;
      case 'error':
        this.item.text = '$(warning) Magipilot';
        this.item.tooltip = `${state.backend}: ${state.message}. Details in the Magipilot output.`;
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
    }
  }

  dispose(): void {
    this.item.dispose();
  }
}
