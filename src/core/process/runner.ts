// Child-process management for the CLI backends, the bench and cli-verify.
// Every child is started in its own process group so the whole tree can be killed, every pid is
// remembered so the caller can prove that nothing leaked, and a watchdog kills the groups if the
// host dies without cleaning up. POSIX only (docs/plans/phase-1.md D12).
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Watchdog } from './watchdog';

export const WINDOWS_UNSUPPORTED = 'CLI backends are not supported on Windows yet';

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  aborted: boolean;
  /** Last ~8 KB of stderr, for error classification only. */
  stderrTail: string;
}

export interface StartOptions {
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Called for every complete stdout line with the time it was read (ms since epoch). */
  onLine?: (line: string, at: number) => void;
}

export interface ProcessHandle {
  readonly pid: number | undefined;
  readonly startedAt: number;
  write(data: string): void;
  end(data?: string): void;
  kill(): void;
  readonly done: Promise<ProcessResult>;
}

const STDERR_TAIL = 8192;
const KILL_GRACE_MS = 1500;

export function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // Group already gone; fall back to the single pid.
    try {
      process.kill(pid, signal);
    } catch {
      /* already exited */
    }
  }
}

export function isGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface RegistryOptions {
  /** Guard children with a watchdog process (default true). */
  watchdog?: boolean;
  /** Binary used to run the watchdog (default process.execPath). */
  watchdogExecPath?: string;
}

export class ProcessRegistry {
  private disposed = false;
  private readonly live = new Set<ProcessHandle>();
  private readonly started: number[] = [];
  private readonly watchdog?: Watchdog;

  constructor(options: RegistryOptions = {}) {
    if (options.watchdog ?? true) {
      this.watchdog = new Watchdog(options.watchdogExecPath);
    }
  }

  /** The watchdog's pid once it has been started (tests). */
  get watchdogPid(): number | undefined {
    return this.watchdog?.pid;
  }

  start(command: string, args: readonly string[], options: StartOptions): ProcessHandle {
    if (process.platform === 'win32') {
      throw new Error(WINDOWS_UNSUPPORTED);
    }
    // Disposal is final: a call that resumes after deactivate starts nothing (P4M-RI002).
    if (this.disposed) throw new Error('process registry disposed');
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const startedAt = Date.now();
    if (child.pid !== undefined) {
      this.started.push(child.pid);
      this.watchdog?.track(child.pid);
    }

    let stderrTail = '';
    let stdoutBuffer = '';
    let timedOut = false;
    let aborted = false;
    let killTimer: NodeJS.Timeout | undefined;

    // Termination is decided by the process group, not the leader: a CLI may exit while a
    // descendant still holds stdout/stderr open, and 'close' only fires once those pipes close.
    const killTree = (): void => {
      if (child.pid === undefined || !isGroupAlive(child.pid)) {
        return;
      }
      killGroup(child.pid, 'SIGTERM');
      killTimer ??= setTimeout(() => {
        if (child.pid !== undefined && isGroupAlive(child.pid)) {
          killGroup(child.pid, 'SIGKILL');
        }
      }, KILL_GRACE_MS);
    };
    // When the leader exits, anything it left in its group is reaped so the pipes close.
    child.on('exit', () => killTree());

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      const at = Date.now();
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline);
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.trim() !== '') {
          options.onLine?.(line, at);
        }
        newline = stdoutBuffer.indexOf('\n');
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL);
    });
    // Writing to a child that already exited raises EPIPE; the exit result reports the failure.
    child.stdin.on('error', () => undefined);

    const timeout =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            killTree();
          }, options.timeoutMs)
        : undefined;

    const onAbort = (): void => {
      aborted = true;
      killTree();
    };
    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener('abort', onAbort, { once: true });
    }

    const handle: ProcessHandle = {
      pid: child.pid,
      startedAt,
      write: (data) => {
        child.stdin.write(data);
      },
      end: (data) => {
        child.stdin.end(data);
      },
      kill: killTree,
      done: new Promise<ProcessResult>((resolve) => {
        let finished = false;
        const finish = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
          if (finished) return;
          finished = true;
          if (timeout) clearTimeout(timeout);
          if (killTimer) clearTimeout(killTimer);
          options.signal?.removeEventListener('abort', onAbort);
          if (stdoutBuffer.trim() !== '') {
            options.onLine?.(stdoutBuffer, Date.now());
            stdoutBuffer = '';
          }
          // Reap anything the CLI left behind in its process group.
          if (child.pid !== undefined && isGroupAlive(child.pid)) {
            killGroup(child.pid, 'SIGKILL');
          }
          if (child.pid !== undefined) this.watchdog?.untrack(child.pid);
          this.live.delete(handle);
          resolve({ exitCode, signal, timedOut, aborted, stderrTail });
        };
        child.on('error', (err) => {
          stderrTail = (stderrTail + String(err)).slice(-STDERR_TAIL);
          finish(null, null);
        });
        child.on('close', finish);
      }),
    };
    this.live.add(handle);
    return handle;
  }

  /** Kills every process tree that is still running. Safe to call from an exit handler. */
  killAll(): void {
    for (const handle of this.live) {
      if (handle.pid !== undefined) {
        killGroup(handle.pid, 'SIGKILL');
      }
    }
  }

  /**
   * Kills every running process tree and stops the watchdog. Every owner calls this when it is
   * done (extension deactivate, script `finally`, test teardown).
   */
  dispose(): void {
    this.disposed = true;
    this.killAll();
    this.watchdog?.close();
  }

  /** Process groups started by this registry that still have a live member. */
  leakedPids(): number[] {
    return this.started.filter(isGroupAlive);
  }

  get startedCount(): number {
    return this.started.length;
  }

  /** Every process group this registry has started, live or not (smoke ownership, phase-5-linux D7). */
  startedGroups(): number[] {
    return [...this.started];
  }

  /** Installs exit/signal handlers that kill all children. Returns an uninstall function. */
  installExitHandlers(): () => void {
    const onExit = (): void => this.killAll();
    const onSignal = (signal: NodeJS.Signals): void => {
      this.killAll();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };
    process.on('exit', onExit);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    return () => {
      process.off('exit', onExit);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };
  }
}

/**
 * Why a finished process counts as failed, or undefined when it exited 0 on its own. A result
 * event followed by a timeout, abort, kill or non-zero exit is still a failure (Faz 0 P0-R2-001).
 * The text is fixed — never the CLI's stderr, which may echo the prompt (AGENTS rule 7,
 * docs/plans/phase-1-local.md C6); the bench adds stderr for its own diagnostics.
 */
export function processFailure(result: ProcessResult): string | undefined {
  if (result.timedOut) return 'timeout';
  if (result.aborted) return 'aborted';
  if (result.exitCode !== 0) return `exit ${result.exitCode ?? result.signal ?? 'unknown'}`;
  return undefined;
}

/**
 * Waits up to `graceMs` for a process to finish on its own, then kills its process group.
 * Never waits unboundedly for a CLI that hangs during shutdown.
 */
export async function stopWithin(handle: ProcessHandle, graceMs: number): Promise<ProcessResult> {
  let timer: NodeJS.Timeout | undefined;
  const exitedInTime = await Promise.race([
    handle.done.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), graceMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (!exitedInTime) handle.kill();
  return handle.done;
}

/**
 * True when `<command> --version` exits 0 within `timeoutMs`. Runs like every CLI call: tracked
 * by the registry (and its watchdog), in an empty temp directory (inspection P1-I004).
 */
export async function probeExecutable(
  registry: ProcessRegistry,
  command: string,
  signal?: AbortSignal,
  timeoutMs = 5000,
): Promise<boolean> {
  const cwd = makeEmptyDir('magipilot-probe-');
  try {
    const handle = registry.start(command, ['--version'], { cwd, timeoutMs, signal });
    handle.end();
    const result = await handle.done;
    return result.exitCode === 0 && !result.timedOut && !result.aborted;
  } catch {
    return false;
  } finally {
    removeDir(cwd);
  }
}

/** Creates an empty private working directory for one CLI call (never the user's workspace). */
export function makeEmptyDir(prefix = 'magipilot-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
