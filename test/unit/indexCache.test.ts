// IndexCache: the content index is never served from a build that started before an
// invalidation (inspection HARD-I004, HARD-I008) or, within a bound, before a file change
// (HARD-I011).
import { describe, expect, it } from 'vitest';
import {
  IndexCache,
  MAX_REBUILDS_AFTER_CHANGE,
  readStable,
} from '../../src/features/chat/indexCache';

/** A build function whose calls resolve only when the test says so. */
function manualBuilds() {
  const pending: { resolve: (value: string) => void; reject: (error: Error) => void }[] = [];
  let count = 0;
  const build = (): Promise<string> =>
    new Promise((resolve, reject) => {
      count += 1;
      pending.push({ resolve, reject });
    });
  return { build, pending, calls: () => count };
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('IndexCache', () => {
  it('builds once for concurrent callers and caches the result', async () => {
    const builds = manualBuilds();
    const cache = new IndexCache(builds.build, 60_000);
    const a = cache.get();
    const b = cache.get();
    await flush();
    expect(builds.calls()).toBe(1);
    builds.pending[0]!.resolve('v1');
    expect(await a).toBe('v1');
    expect(await b).toBe('v1');
    expect(await cache.get()).toBe('v1');
    expect(builds.calls()).toBe(1);
  });

  it('never returns a build that started before invalidate(), to waiting or later callers', async () => {
    const builds = manualBuilds();
    const cache = new IndexCache(builds.build, 60_000);
    const waiting = cache.get();
    await flush();
    cache.invalidate(); // e.g. magipilot.exclude changed while the first build ran
    const later = cache.get();
    await flush();
    expect(builds.calls()).toBe(2);
    builds.pending[0]!.resolve('old patterns');
    await flush();
    builds.pending[1]!.resolve('new patterns');
    expect(await waiting).toBe('new patterns');
    expect(await later).toBe('new patterns');
    expect(await cache.get()).toBe('new patterns');
  });

  it('an older build finishing late does not clear or replace a newer one', async () => {
    const builds = manualBuilds();
    const cache = new IndexCache(builds.build, 60_000);
    void cache.get();
    await flush();
    cache.invalidate();
    const current = cache.get();
    await flush();
    builds.pending[1]!.resolve('new');
    expect(await current).toBe('new');
    builds.pending[0]!.resolve('old');
    await flush();
    expect(await cache.get()).toBe('new');
    expect(builds.calls()).toBe(2);
  });

  it('an older build that fails after invalidate() does not fail its waiting caller (HARD-I008)', async () => {
    for (const order of ['old fails first', 'new succeeds first'] as const) {
      const builds = manualBuilds();
      const cache = new IndexCache(builds.build, 60_000);
      const waiting = cache.get();
      const alsoWaiting = cache.get();
      await flush();
      cache.invalidate();
      const later = cache.get();
      await flush();
      expect(builds.calls()).toBe(2);
      if (order === 'old fails first') {
        builds.pending[0]!.reject(new Error('old build failed'));
        await flush();
        builds.pending[1]!.resolve('new');
      } else {
        builds.pending[1]!.resolve('new');
        await flush();
        builds.pending[0]!.reject(new Error('old build failed'));
      }
      expect(await waiting).toBe('new');
      expect(await alsoWaiting).toBe('new');
      expect(await later).toBe('new');
      expect(builds.calls()).toBe(2);
    }
  });

  it('a failure of the current build still reaches its callers', async () => {
    const builds = manualBuilds();
    const cache = new IndexCache(builds.build, 60_000);
    const waiting = cache.get();
    await flush();
    builds.pending[0]!.reject(new Error('current build failed'));
    await expect(waiting).rejects.toThrow('current build failed');
  });

  it('a file change during a build gives waiting and later callers a new build (HARD-I011)', async () => {
    const builds = manualBuilds();
    const cache = new IndexCache(builds.build, 60_000);
    const a = cache.get();
    await flush();
    cache.drop(); // a matching file was saved after the build read it
    const b = cache.get();
    await flush();
    expect(builds.calls()).toBe(2);
    builds.pending[0]!.resolve('before the change');
    await flush();
    builds.pending[1]!.resolve('after the change');
    expect(await a).toBe('after the change');
    expect(await b).toBe('after the change');
    expect(await cache.get()).toBe('after the change');
    expect(builds.calls()).toBe(2);
  });

  it('a file that keeps changing cannot stall a caller: it takes the result after the last rebuild', async () => {
    const builds = manualBuilds();
    const cache = new IndexCache(builds.build, 60_000);
    const waiting = cache.get();
    for (let n = 0; n <= MAX_REBUILDS_AFTER_CHANGE; n++) {
      await flush();
      cache.drop();
      builds.pending[n]!.resolve(`build ${n}`);
    }
    expect(await waiting).toBe(`build ${MAX_REBUILDS_AFTER_CHANGE}`);
    expect(builds.calls()).toBe(MAX_REBUILDS_AFTER_CHANGE + 1);
  });

  it('rebuilds after the TTL and after a failed build', async () => {
    let now = 0;
    const builds = manualBuilds();
    const cache = new IndexCache(builds.build, 1_000, () => now);
    const first = cache.get();
    await flush();
    builds.pending[0]!.reject(new Error('no disk'));
    await expect(first).rejects.toThrow('no disk');
    const second = cache.get();
    await flush();
    builds.pending[1]!.resolve('v2');
    expect(await second).toBe('v2');
    now = 1_000;
    const third = cache.get();
    await flush();
    expect(builds.calls()).toBe(3);
    builds.pending[2]!.resolve('v3');
    expect(await third).toBe('v3');
  });
});

describe('readStable (FOLLOWUP-I003)', () => {
  it('reads once when the settings do not change', async () => {
    let reads = 0;
    const result = await readStable(
      () => 7,
      () => Promise.resolve(++reads),
    );
    expect(result).toEqual({ value: 1, stable: true });
  });

  it('reads again when the settings changed during a read', async () => {
    let generation = 0;
    let reads = 0;
    const result = await readStable(
      () => generation,
      () => {
        reads += 1;
        if (reads === 1) generation += 1; // e.g. secrets/** added between two name searches
        return Promise.resolve(reads);
      },
    );
    expect(result).toEqual({ value: 2, stable: true });
  });

  it('reports settings that keep changing after the last attempt', async () => {
    let generation = 0;
    let reads = 0;
    const result = await readStable(
      () => generation,
      () => {
        reads += 1;
        generation += 1;
        return Promise.resolve(reads);
      },
      3,
    );
    expect(result).toEqual({ value: 3, stable: false });
  });
});
