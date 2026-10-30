// Host process used by watchdog.test.ts (run with `node --import tsx`).
// Modes:
//   idle    – start a fake CLI (keeps stdin open), report pids, wait to be killed
//   active  – same, but close the fake CLI's stdin first (a request in flight)
//   natural – run a short child, report the watchdog pid and return without dispose/exit
import { ProcessRegistry } from '../../../src/core/process/runner';

const mode = process.argv[2] ?? 'idle';
// "active-no-watchdog" is the negative control: it shows the test can detect a leak.
const registry = new ProcessRegistry({ watchdog: mode !== 'active-no-watchdog' });

// The fake CLI ignores stdin EOF on purpose (worst case) and owns a grandchild.
const FAKE_CLI = `
const { spawn } = require('node:child_process');
const grandchild = spawn('sleep', ['60'], { stdio: 'ignore' });
console.log('GRANDCHILD ' + grandchild.pid);
process.stdin.on('end', () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
`;

async function main(): Promise<void> {
  if (mode === 'natural') {
    const handle = registry.start(process.execPath, ['-e', 'console.log("ok")'], {
      cwd: process.cwd(),
    });
    await handle.done;
    console.log(`DONE ${registry.watchdogPid ?? 0}`);
    return; // no dispose, no process.exit: the host must still exit by itself
  }
  const handle = registry.start(process.execPath, ['-e', FAKE_CLI], {
    cwd: process.cwd(),
    onLine: (line) => {
      if (line.startsWith('GRANDCHILD ')) {
        if (mode.startsWith('active')) handle.end();
        console.log(`READY ${handle.pid} ${line.split(' ')[1]} ${registry.watchdogPid ?? 0}`);
      }
    },
  });
  await new Promise(() => undefined); // wait to be SIGKILLed
}

void main();
