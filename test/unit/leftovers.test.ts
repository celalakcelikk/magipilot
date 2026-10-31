// A12 (docs/plans/phase-5-linux.md D7): the smoke runs report and kill only processes they own.
import { describe, expect, it } from 'vitest';
import { classifyLeftovers, isClean, killOwned } from '../../scripts/lib/leftovers.mjs';

describe('smoke leftovers (phase-5-linux D7)', () => {
  it('counts a live recorded group whose members carry no marker', () => {
    // A real CLI under a wrapper that was already killed: no marker left, but its group lives.
    const leftovers = classifyLeftovers({
      markerPids: [],
      recordedGroups: [400, 500],
      groupAlive: (pgid) => pgid === 500,
    });
    expect(leftovers).toEqual({ pids: [], groups: [500] });
    expect(isClean(leftovers)).toBe(false);
  });

  it('counts a marker process even when its group was never recorded', () => {
    // Started after the in-VS Code step wrote its results.
    const leftovers = classifyLeftovers({
      markerPids: [610, 610],
      recordedGroups: [],
      groupAlive: () => false,
    });
    expect(leftovers).toEqual({ pids: [610], groups: [] });
  });

  it('kills the group of an unrecorded marked wrapper, reaching its unmarked child (LINUX-I006)', () => {
    // A wrapper (pid 700, leader of group 700) started after the results were written; its real
    // CLI child carries no marker but lives in group 700.
    const leftovers = classifyLeftovers({
      markerPids: [700],
      recordedGroups: [],
      groupAlive: (pgid) => pgid === 700,
      pgidOf: (pid) => (pid === 700 ? 700 : undefined),
    });
    expect(leftovers).toEqual({ pids: [700], groups: [700] });
    const killed: number[] = [];
    killOwned(leftovers, (pid) => killed.push(pid));
    expect(killed).toEqual([700, -700]);
  });

  it('does not take over the group of a marked process that does not lead it', () => {
    const leftovers = classifyLeftovers({
      markerPids: [711],
      recordedGroups: [],
      groupAlive: () => true,
      pgidOf: () => 500,
    });
    expect(leftovers).toEqual({ pids: [711], groups: [] });
  });

  it('ignores and never kills a stranger: no marker and no recorded group', () => {
    const stranger = 999;
    const leftovers = classifyLeftovers({
      markerPids: [610],
      recordedGroups: [500],
      groupAlive: (pgid) => pgid === 500 || pgid === stranger,
    });
    const killed: number[] = [];
    killOwned(leftovers, (pid) => killed.push(pid));
    expect(killed).toEqual([610, -500]);
    expect(killed).not.toContain(stranger);
    expect(killed).not.toContain(-stranger);
  });

  it('is clean when nothing owned is left', () => {
    const leftovers = classifyLeftovers({
      markerPids: [],
      recordedGroups: [400, 500],
      groupAlive: () => false,
    });
    expect(isClean(leftovers)).toBe(true);
    const killed: number[] = [];
    killOwned(leftovers, (pid) => killed.push(pid));
    expect(killed).toEqual([]);
  });

  it('keeps going when a kill fails (the process is already gone)', () => {
    const killed: number[] = [];
    killOwned({ pids: [1, 2], groups: [3] }, (pid) => {
      killed.push(pid);
      if (pid === 1) throw new Error('ESRCH');
    });
    expect(killed).toEqual([1, 2, -3]);
  });
});
