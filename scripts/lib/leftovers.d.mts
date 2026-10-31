// Types for leftovers.mjs, which plain Node runs from scripts/smoke-processes.mjs.
export interface Leftovers {
  pids: number[];
  groups: number[];
}

export function classifyLeftovers(input: {
  markerPids: number[];
  recordedGroups: number[];
  groupAlive: (pgid: number) => boolean;
  pgidOf?: (pid: number) => number | undefined;
}): Leftovers;

export function isClean(leftovers: Leftovers): boolean;

export function killOwned(leftovers: Leftovers, kill: (pid: number, signal: string) => void): void;
