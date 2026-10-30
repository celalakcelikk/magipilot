import { describe, expect, it } from 'vitest';
import { WarmPool } from '../../src/core/process/warmPool';

interface Item {
  id: number;
  alive: boolean;
  discarded: boolean;
}

function setup(options: { size?: number; minIdleMs?: number; maxIdleMs?: number } = {}) {
  let now = 0;
  let next = 0;
  const spawned: Item[] = [];
  const slept: number[] = [];
  const pool = new WarmPool<Item>({
    size: options.size ?? 1,
    minIdleMs: options.minIdleMs,
    maxIdleMs: options.maxIdleMs,
    spawn: () => {
      const item = { id: next++, alive: true, discarded: false };
      spawned.push(item);
      return item;
    },
    discard: (item) => {
      item.discarded = true;
      item.alive = false;
    },
    isAlive: (item) => item.alive,
    now: () => now,
    sleep: (ms) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
  });
  return { pool, spawned, slept, advance: (ms: number) => (now += ms) };
}

describe('WarmPool', () => {
  it('prime fills the pool to its size', () => {
    const { pool, spawned } = setup({ size: 2 });
    pool.prime();
    pool.prime();
    expect(spawned).toHaveLength(2);
    expect(pool.spareCount).toBe(2);
  });

  it('take hands out the oldest spare and starts a replacement', async () => {
    const { pool, spawned } = setup();
    pool.prime();
    const item = await pool.take();
    expect(item.id).toBe(0);
    expect(spawned).toHaveLength(2);
    expect(pool.spareCount).toBe(1);
  });

  it('take spawns on demand when the pool was never primed', async () => {
    const { pool } = setup();
    expect((await pool.take()).id).toBe(0);
    expect(pool.spareCount).toBe(1);
  });

  it('waits out the minimum idle time', async () => {
    const { pool, slept, advance } = setup({ minIdleMs: 3000 });
    pool.prime();
    advance(1000);
    await pool.take();
    expect(slept).toEqual([2000]);
  });

  it('does not wait for a spare that is old enough', async () => {
    const { pool, slept, advance } = setup({ minIdleMs: 3000 });
    pool.prime();
    advance(5000);
    await pool.take();
    expect(slept).toEqual([]);
  });

  it('replaces a spare that died on its own', async () => {
    const { pool, spawned } = setup();
    pool.prime();
    spawned[0]!.alive = false;
    const item = await pool.take();
    expect(item.id).toBe(1);
    expect(spawned[0]!.discarded).toBe(true);
  });

  it('replaces spares older than maxIdleMs', async () => {
    const { pool, spawned, advance } = setup({ maxIdleMs: 60_000 });
    pool.prime();
    advance(61_000);
    expect((await pool.take()).id).toBe(1);
    expect(spawned[0]!.discarded).toBe(true);
  });

  it('dispose discards every spare and refuses further use', async () => {
    const { pool, spawned } = setup({ size: 2 });
    pool.prime();
    await pool.dispose();
    expect(spawned.every((item) => item.discarded)).toBe(true);
    expect(pool.spareCount).toBe(0);
    pool.prime();
    expect(spawned).toHaveLength(2);
    await expect(pool.take()).rejects.toThrow(/disposed/);
  });

  it('rejects size 0', () => {
    expect(() => setup({ size: 0 })).toThrow();
  });
});
