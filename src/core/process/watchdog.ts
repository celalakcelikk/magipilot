// Host-death guard for CLI children (docs/plans/phase-1.md D13, review P1-R001).
// A CLI's stdin is closed while its request is still running, so stdin EOF cannot be relied on
// to stop it when the extension host dies. The watchdog is a separate, detached process whose
// stdin is a pipe from the host: it learns process groups through `track <pgid>` /
// `untrack <pgid>` lines and, when that pipe reaches EOF (the host exited or was killed),
// terminates every group still tracked. It reads nothing else and never runs model output.
import { spawn, type ChildProcess } from 'node:child_process';

/** Watchdog program, run as `<node> -e WATCHDOG_SOURCE`. Plain JavaScript, no dependencies. */
export const WATCHDOG_SOURCE = `
const tracked = new Set();
let buffer = '';
const killAll = (signal) => {
  for (const pgid of tracked) {
    try { process.kill(-pgid, signal); } catch { try { process.kill(pgid, signal); } catch {} }
  }
};
const anyAlive = () => {
  for (const pgid of tracked) {
    try { process.kill(-pgid, 0); return true; } catch (err) { if (err.code === 'EPERM') return true; }
  }
  return false;
};
const finish = () => {
  if (tracked.size === 0) process.exit(0);
  killAll('SIGTERM');
  // Exit as soon as every group is gone; SIGKILL whatever is left after 1.5 s.
  const deadline = Date.now() + 1500;
  const timer = setInterval(() => {
    if (!anyAlive()) { clearInterval(timer); process.exit(0); }
    if (Date.now() >= deadline) { clearInterval(timer); killAll('SIGKILL'); process.exit(0); }
  }, 50);
};
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf('\\n');
  while (newline >= 0) {
    const [command, value] = buffer.slice(0, newline).split(' ');
    buffer = buffer.slice(newline + 1);
    const pgid = Number(value);
    if (Number.isInteger(pgid) && pgid > 1) {
      if (command === 'track') tracked.add(pgid);
      else if (command === 'untrack') tracked.delete(pgid);
    }
    newline = buffer.indexOf('\\n');
  }
});
process.stdin.on('end', finish);
process.stdin.on('error', finish);
`;

export class Watchdog {
  private child?: ChildProcess;

  /** @param execPath a node-compatible binary; inside VS Code this is the extension host binary. */
  constructor(private readonly execPath: string = process.execPath) {}

  get pid(): number | undefined {
    return this.child?.pid;
  }

  private ensure(): ChildProcess {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      return this.child;
    }
    const child = spawn(this.execPath, ['-e', WATCHDOG_SOURCE], {
      // Own process group: a signal sent to the host's group must not take the watchdog down.
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
      // Inside VS Code, process.execPath is Electron; this makes it behave like node.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    // Never keep the host alive (review P1-R004): neither the child nor its stdin pipe.
    child.unref();
    (child.stdin as unknown as { unref?: () => void } | null)?.unref?.();
    child.stdin?.on('error', () => undefined);
    this.child = child;
    return child;
  }

  track(pgid: number): void {
    this.ensure().stdin?.write(`track ${pgid}\n`);
  }

  untrack(pgid: number): void {
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      child.stdin?.write(`untrack ${pgid}\n`);
    }
  }

  /** Closes the pipe; the watchdog then exits (after killing anything still tracked). */
  close(): void {
    this.child?.stdin?.end();
    this.child = undefined;
  }
}
