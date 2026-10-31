// Process ownership for the smoke runs (docs/plans/phase-5-linux.md D7). After VS Code has closed,
// a leftover is either a process whose command line carries the run's unique marker (the wrapper
// or fake CLI folder), or a live member of a process group the extension's registry started. A
// marked process that leads its own group (every registry spawn does) owns that group too, so its
// unmarked children are found even when the group was never recorded (inspection LINUX-I006). A
// process that is none of these belongs to someone else: it is never reported, and never killed.

/**
 * @param {{
 *   markerPids: number[],
 *   recordedGroups: number[],
 *   groupAlive: (pgid: number) => boolean,
 *   pgidOf?: (pid: number) => number | undefined,
 * }} input
 * @returns {{ pids: number[], groups: number[] }}
 */
export function classifyLeftovers({ markerPids, recordedGroups, groupAlive, pgidOf }) {
  const pids = [...new Set(markerPids)];
  const leaders = pgidOf ? pids.filter((pid) => pgidOf(pid) === pid) : [];
  return {
    pids,
    groups: [...new Set([...recordedGroups, ...leaders])].filter((pgid) => groupAlive(pgid)),
  };
}

/** True when the leftovers name no process and no group. */
export function isClean(leftovers) {
  return leftovers.pids.length === 0 && leftovers.groups.length === 0;
}

/**
 * Sends SIGKILL to the owned leftovers only: each marker pid, and each owned group as a whole.
 * @param {{ pids: number[], groups: number[] }} leftovers
 * @param {(pid: number, signal: string) => void} kill `process.kill`, or a recorder in tests
 */
export function killOwned(leftovers, kill) {
  for (const pid of leftovers.pids) {
    try {
      kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  for (const pgid of leftovers.groups) {
    try {
      kill(-pgid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
