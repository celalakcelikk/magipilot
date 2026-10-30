// AC3 (docs/plans/phase-3-package.md): runs inside a VS Code whose extensions directory holds only
// the installed .vsix (scripts/smoke-vsix.mjs). Checks that Magipilot is the installed copy, that it
// activates, and that its user commands exist. Writes the results; never calls a CLI.
import { writeFileSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';
import * as vscode from 'vscode';

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const USER_COMMANDS = [
  'magipilot.toggleInline',
  'magipilot.triggerInline',
  'magipilot.useForCommitMessages',
  'magipilot.showLog',
  'magipilot.showStats',
  'magipilot.resetStats',
];

export async function run(): Promise<void> {
  const failures: string[] = [];
  const extension = vscode.extensions.getExtension(env('MAGIPILOT_VSIX_ID'));
  const result: Record<string, unknown> = { found: extension !== undefined };
  if (!extension) {
    failures.push('the extension is not installed');
  } else {
    const fromDir = relative(env('MAGIPILOT_VSIX_EXTENSIONS_DIR'), extension.extensionPath);
    result.extensionPath = extension.extensionPath;
    result.version = (extension.packageJSON as { version?: string }).version;
    if (fromDir.startsWith('..') || isAbsolute(fromDir)) {
      failures.push(`loaded from ${extension.extensionPath}, not from the installed copy`);
    }
    if (result.version !== env('MAGIPILOT_VSIX_VERSION')) {
      failures.push(`version ${String(result.version)}`);
    }
    try {
      await extension.activate();
      result.active = extension.isActive;
    } catch (err) {
      failures.push(`activation failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const commands = await vscode.commands.getCommands(true);
    const missing = USER_COMMANDS.filter((command) => !commands.includes(command));
    result.missingCommands = missing;
    if (missing.length) failures.push(`commands not registered: ${missing.join(', ')}`);
    // Show Stats opens its panel from the installed bundle (a quick end-to-end check).
    try {
      await vscode.commands.executeCommand('magipilot.showStats');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    } catch (err) {
      failures.push(`Show Stats failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  writeFileSync(env('MAGIPILOT_VSIX_RESULTS'), JSON.stringify({ ...result, failures }, null, 2));
}
