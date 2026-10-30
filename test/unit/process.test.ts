import { afterEach, describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { isGroupAlive, ProcessRegistry, stopWithin } from '../../src/core/process/runner';

const node = process.execPath;

const registries: ProcessRegistry[] = [];
function newRegistry(): ProcessRegistry {
  const registry = new ProcessRegistry();
  registries.push(registry);
  return registry;
}

afterEach(() => {
  for (const registry of registries.splice(0)) registry.dispose();
});

describe('ProcessRegistry', () => {
  it('collects stdout lines and the exit code', async () => {
    const registry = newRegistry();
    const lines: string[] = [];
    const handle = registry.start(node, ['-e', 'console.log("a"); console.log("b")'], {
      cwd: process.cwd(),
      onLine: (line) => lines.push(line),
    });
    const result = await handle.done;
    expect(result.exitCode).toBe(0);
    expect(lines).toEqual(['a', 'b']);
    expect(registry.leakedPids()).toEqual([]);
  });

  it('passes stdin through and closes it', async () => {
    const registry = newRegistry();
    const lines: string[] = [];
    const handle = registry.start(
      node,
      [
        '-e',
        'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(s.toUpperCase()))',
      ],
      { cwd: process.cwd(), onLine: (line) => lines.push(line) },
    );
    handle.end('prompt');
    await handle.done;
    expect(lines).toEqual(['PROMPT']);
  });

  it('kills the whole process group on timeout, grandchildren included', async () => {
    const registry = newRegistry();
    const handle = registry.start('sh', ['-c', 'sleep 30 & sleep 30'], {
      cwd: process.cwd(),
      timeoutMs: 300,
    });
    const result = await handle.done;
    expect(result.timedOut).toBe(true);
    expect(isGroupAlive(handle.pid!)).toBe(false);
    expect(registry.leakedPids()).toEqual([]);
  });

  it('reaps a descendant that keeps the pipes open after the leader exits (review P0-I004)', async () => {
    const registry = newRegistry();
    const startedAt = Date.now();
    // The leader exits at once; the background sleep inherits stdout and would keep 'close'
    // pending for 30 s if only the leader were watched.
    const handle = registry.start('sh', ['-c', 'sleep 30 & exit 0'], { cwd: process.cwd() });
    const result = await handle.done;
    expect(result.exitCode).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(isGroupAlive(handle.pid!)).toBe(false);
    expect(registry.leakedPids()).toEqual([]);
  });

  it('stopWithin kills a process that does not exit within the grace time', async () => {
    const registry = newRegistry();
    const handle = registry.start(node, ['-e', 'setTimeout(() => {}, 30000)'], {
      cwd: process.cwd(),
    });
    const startedAt = Date.now();
    const result = await stopWithin(handle, 200);
    expect(Date.now() - startedAt).toBeLessThan(5000);
    expect(result.signal).not.toBeNull();
    expect(registry.leakedPids()).toEqual([]);
  });

  it('kills on abort and via killAll', async () => {
    const registry = newRegistry();
    const controller = new AbortController();
    const aborted = registry.start(node, ['-e', 'setTimeout(() => {}, 30000)'], {
      cwd: process.cwd(),
      signal: controller.signal,
    });
    const other = registry.start(node, ['-e', 'setTimeout(() => {}, 30000)'], {
      cwd: process.cwd(),
    });
    controller.abort();
    expect((await aborted.done).aborted).toBe(true);
    registry.killAll();
    await other.done;
    expect(registry.startedCount).toBe(2);
    expect(registry.leakedPids()).toEqual([]);
  });

  it('keeps a process waiting while stdin stays open (the Codex hang the AGENTS rule guards against)', async () => {
    const registry = newRegistry();
    const handle = registry.start(
      node,
      ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.exit(0))'],
      {
        cwd: process.cwd(),
      },
    );
    let exited = false;
    void handle.done.then(() => {
      exited = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(exited).toBe(false);
    handle.end();
    expect((await handle.done).exitCode).toBe(0);
  });
});

describe('ProcessRegistry disposal (inspection P4M-RI002)', () => {
  it('starts nothing after dispose()', () => {
    const disposed = new ProcessRegistry();
    disposed.dispose();
    expect(() => disposed.start('true', [], { cwd: tmpdir() })).toThrow(/disposed/);
  });
});
