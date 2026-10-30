import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const HOST = join(__dirname, 'helpers', 'crashHost.ts');
const ROOT = join(__dirname, '..', '..');

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return condition();
}

function startHost(mode: string): { host: ChildProcess; line: Promise<string> } {
  const host = spawn(process.execPath, ['--import', 'tsx', HOST, mode], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const line = new Promise<string>((resolve, reject) => {
    let buffer = '';
    host.stdout.setEncoding('utf8');
    host.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      const match = /^(READY|DONE) .*$/m.exec(buffer);
      if (match) resolve(match[0]);
    });
    host.on('exit', () => reject(new Error(`host exited before reporting: ${buffer}`)));
  });
  return { host, line };
}

describe('watchdog: children die with a killed host (review P1-R001)', () => {
  for (const mode of ['idle', 'active']) {
    it(`host SIGKILL while the fake CLI is ${mode === 'idle' ? 'idle (stdin open)' : 'running with stdin already closed'}`, async () => {
      const { host, line } = startHost(mode);
      const [, cli, grandchild, watchdog] = (await line).split(' ').map(Number);
      expect(cli).toBeGreaterThan(0);
      expect(grandchild).toBeGreaterThan(0);
      expect(watchdog).toBeGreaterThan(0);
      expect(isAlive(cli!)).toBe(true);
      expect(isAlive(grandchild!)).toBe(true);

      host.kill('SIGKILL'); // no exit handler, no deactivate: only the watchdog can clean up

      expect(await waitUntil(() => !isAlive(cli!) && !isAlive(grandchild!), 5000)).toBe(true);
      expect(await waitUntil(() => !isAlive(watchdog!), 5000)).toBe(true);
    });
  }
});

describe('negative control', () => {
  it('without the watchdog the CLI and its grandchild survive a host SIGKILL (the test is sensitive)', async () => {
    const { host, line } = startHost('active-no-watchdog');
    const [, cli, grandchild] = (await line).split(' ').map(Number);
    host.kill('SIGKILL');
    try {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      expect(isAlive(cli!)).toBe(true);
      expect(isAlive(grandchild!)).toBe(true);
    } finally {
      // Clean up what this control deliberately leaked.
      for (const pid of [cli!, grandchild!]) {
        try {
          process.kill(-cli!, 'SIGKILL');
        } catch {
          /* group gone */
        }
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          /* gone */
        }
      }
    }
  });
});

describe('watchdog: never keeps its host alive (review P1-R004)', () => {
  it('a host that returns without dispose, exit or signal exits by itself, and so does the watchdog', async () => {
    const { host, line } = startHost('natural');
    const exited = new Promise<number | null>((resolve) => host.on('exit', resolve));
    const [, watchdog] = (await line).split(' ').map(Number);
    expect(watchdog).toBeGreaterThan(0);
    const code = await Promise.race([
      exited,
      new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 5000)),
    ]);
    expect(code).toBe(0);
    expect(await waitUntil(() => !isAlive(watchdog!), 5000)).toBe(true);
  });
});
