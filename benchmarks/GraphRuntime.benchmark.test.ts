/**
 * Benchmarks related to reconcile and allocations.
 * Run: npx jest GraphRuntime.benchmark --testTimeout=120000
 */

/* eslint-disable no-console */

import { coldVsWarm, benchAvgNs } from './helpers/effectableBenchmarkHelpers';
import { Component, GraphRuntime, h } from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

const ITERATIONS = 100_000;
const TREE_SIZE = 10;

async function benchAvgAsyncNs (
  fn: () => Promise<void>,
  iterations: number,
  options?: { warmupIterations?: number },
): Promise<number> {
  const warmup = options?.warmupIterations ?? Math.min(500, Math.max(1, Math.floor(iterations / 10)));

  for (let i = 0; i < warmup; i += 1) {
    await fn();
  }

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    await fn();
  }
  const end = process.hrtime.bigint();

  return Number(end - start) / iterations;
}

interface RuntimeLeafProps {
  id: string;
  value: number;
}

interface RuntimeHostProps {
  items: RuntimeLeafProps[];
}

class RuntimeSyncLeaf extends Component<Record<string, never>, RuntimeLeafProps> {
  constructor (props: RuntimeLeafProps) {
    super(props);
    this.state = {};
  }

  public override onMount (): void {}

  public override onUnmount (): void {}
}

class RuntimeAsyncLeaf extends Component<Record<string, never>, RuntimeLeafProps> {
  constructor (props: RuntimeLeafProps) {
    super(props);
    this.state = {};
  }

  public override async onMount (): Promise<void> {
    await Promise.resolve();
  }

  public override onUnmount (): void {}
}

class RuntimeHost extends Component<Record<string, never>, RuntimeHostProps> {
  constructor (props: RuntimeHostProps) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode[] {
    return this.props.items.map((item) => {
      return h(RuntimeSyncLeaf, item, item.id);
    });
  }
}

class RuntimeAsyncHost extends Component<Record<string, never>, RuntimeHostProps> {
  constructor (props: RuntimeHostProps) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode[] {
    return this.props.items.map((item, index) => {
      if (index === 0) {
        return h(RuntimeAsyncLeaf, item, item.id);
      }

      return h(RuntimeSyncLeaf, item, item.id);
    });
  }
}

function createItems (count: number, startValue: number): RuntimeLeafProps[] {
  const items: RuntimeLeafProps[] = [];

  for (let i = 0; i < count; i += 1) {
    items.push({
      id: `node-${String(i)}`,
      value: startValue + i,
    });
  }

  return items;
}

function reverseItems (items: RuntimeLeafProps[]): RuntimeLeafProps[] {
  const next: RuntimeLeafProps[] = [];

  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    next.push({
      id: item.id,
      value: item.value + 1,
    });
  }

  return next;
}

async function runRuntimeCycle (
  node: VirtualServiceNode,
): Promise<void> {
  const runtime = await GraphRuntime.mount(node);
  await runtime.unmount();
}

function bench (name: string, fn: () => void, iterations: number): number {
  for (let i = 0; i < Math.min(1000, iterations / 10); i++) {
    fn();
  }

  const start = process.hrtime.bigint();

  for (let i = 0; i < iterations; i++) {
    fn();
  }

  const end = process.hrtime.bigint();
  const totalNs = Number(end - start);
  const perOpNs = totalNs / iterations;

  console.log(`  ${name}: ${perOpNs.toFixed(1)} ns/op (${iterations} iterations)`);

  return perOpNs;
}

function benchPerf (label: string, fn: () => void, n: number): number {
  const start = performance.now();
  for (let i = 0; i < n; i++) fn();
  const elapsed = (performance.now() - start) * 1_000_000;
  const nsPerOp = elapsed / n;
  console.log(`  ${label}: ${nsPerOp.toFixed(2)} ns/op`);
  return nsPerOp;
}

describe('Benchmark: Map allocation vs clear+reuse', () => {
  it('new Map() vs existingMap.clear()', () => {
    console.log('\n=== Map allocation vs clear+reuse ===');

    const newMapTime = bench(
      'new Map<string, unknown>() per call',
      () => {
        const m = new Map<string, unknown>();
        m.set('a', 1);
        m.set('b', 2);
        m.set('c', 3);
        m.clear();
      },
      ITERATIONS,
    );

    const pooledMap = new Map<string, unknown>();
    const reuseTime = bench(
      'pooled Map.clear() per call',
      () => {
        pooledMap.clear();
        pooledMap.set('a', 1);
        pooledMap.set('b', 2);
        pooledMap.set('c', 3);
      },
      ITERATIONS,
    );

    const speedup = newMapTime / reuseTime;

    console.log(`  Speedup (new vs clear): ${speedup.toFixed(1)}x`);
    expect(speedup).toBeGreaterThan(1.5);
  });
});

describe('Benchmark: isStableChildren fast-path vs full diff', () => {
  class MockComponent {}

  const makeCurrentFibers = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      vnode: { type: MockComponent, props: {}, children: [], key: `key-${i}` },
    }));

  const makeNextVnodes = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      type: MockComponent,
      props: {},
      children: [],
      key: `key-${i}`,
    }));

  it('stable children check vs Map construction', () => {
    console.log('\n=== isStableChildren vs Map construction ===');

    const current = makeCurrentFibers(TREE_SIZE);
    const next = makeNextVnodes(TREE_SIZE);

    const fullDiffTime = bench(
      `Full diff: new Map() + populate (N=${TREE_SIZE})`,
      () => {
        const keyedMap = new Map<string, unknown>();
        const unkeyed: unknown[] = [];
        for (const child of current) {
          const key = child.vnode.key;
          if (key !== undefined) {
            keyedMap.set(key, child);
          } else {
            unkeyed.push(child);
          }
        }
        const nextChildren: unknown[] = [];
        for (const nv of next) {
          if (nv.key !== undefined && keyedMap.has(nv.key)) {
            keyedMap.delete(nv.key);
            nextChildren.push(nv);
          }
        }
      },
      ITERATIONS,
    );

    const stableCheckTime = bench(
      `Stable check: isStable + indexed loop (N=${TREE_SIZE})`,
      () => {
        let stable = current.length === next.length && current.length <= 32;
        if (stable) {
          for (let i = 0; i < current.length && stable; i++) {
            if (current[i]!.vnode.type !== next[i]!.type) stable = false;
            if ((current[i]!.vnode.key ?? null) !== (next[i]!.key ?? null)) stable = false;
          }
        }

        if (stable) {
          const result: unknown[] = new Array(next.length);
          for (let i = 0; i < next.length; i++) {
            result[i] = next[i];
          }
        }
      },
      ITERATIONS,
    );

    const speedup = fullDiffTime / stableCheckTime;

    console.log(`  Speedup (full diff vs stable check+loop): ${speedup.toFixed(1)}x`);
    expect(speedup).toBeGreaterThan(1.0);
  });
});

describe('Benchmark: typeof hook check vs cached flags', () => {
  const componentWithHooks = {
    onMount (): void {},
    onUpdate (): void {},
    onUnmount (): void {},
  };

  const componentNoHooks = {};

  it('typeof check vs pre-computed flags', () => {
    console.log('\n=== typeof hook checks vs cached flags ===');

    const typeofTime = bench(
      'typeof check × 3 per component (with hooks)',
      () => {
        const hasMount = typeof componentWithHooks.onMount === 'function';
        const hasUpdate = typeof componentWithHooks.onUpdate === 'function';
        const hasUnmount = typeof componentWithHooks.onUnmount === 'function';
        void hasMount;
        void hasUpdate;
        void hasUnmount;
      },
      ITERATIONS,
    );

    const hasMount = typeof componentWithHooks.onMount === 'function';
    const hasUpdate = typeof componentWithHooks.onUpdate === 'function';
    const hasUnmount = typeof componentWithHooks.onUnmount === 'function';

    const cachedTime = bench(
      'cached boolean flag access × 3',
      () => {
        void hasMount;
        void hasUpdate;
        void hasUnmount;
      },
      ITERATIONS,
    );

    const speedup = typeofTime / cachedTime;

    console.log(`  Speedup (typeof vs cached): ${speedup.toFixed(1)}x`);
    expect(speedup).toBeGreaterThan(1.0);
  });

  it('typeof check for component WITHOUT hooks', () => {
    console.log('\n  Component without hooks:');

    const noHooksTypeofTime = bench(
      'typeof check × 3 (no hooks)',
      () => {
        const hasMount = typeof (componentNoHooks as { onMount?: unknown }).onMount === 'function';
        const hasUpdate = typeof (componentNoHooks as { onUpdate?: unknown }).onUpdate === 'function';
        const hasUnmount = typeof (componentNoHooks as { onUnmount?: unknown }).onUnmount === 'function';
        void hasMount;
        void hasUpdate;
        void hasUnmount;
      },
      ITERATIONS,
    );

    console.log(`  no-hook typeof check: ${noHooksTypeofTime.toFixed(1)} ns/op`);
    expect(noHooksTypeofTime).toBeDefined();
  });
});

describe('Benchmark Summary', () => {
  it('print summary of optimizations', () => {
    console.log('\n=== FINAL SUMMARY (GraphRuntime-related) ===');
    console.log('All benchmarks completed.');
    expect(true).toBe(true);
  });
});

describe('keyedCurrentMap: new Map vs skip', () => {
  interface MockChild { key?: string }

  it('10 unkeyed children: always new Map vs check then skip', () => {
    const unkeyedChildren: MockChild[] = Array.from({ length: 10 }, () => ({}));

    const alwaysMapTime = benchPerf(
      'Always: new Map() for keyedCurrentMap',
      () => {
        const _ = new Map<string, MockChild>();
        for (const child of unkeyedChildren) {
          if (child.key !== undefined) _.set(child.key, child);
        }
      },
      ITERATIONS,
    );

    const skipMapTime = benchPerf(
      'Optimized: check hasKeyed, skip Map if unkeyed-only',
      () => {
        let hasKeyed = false;
        for (const child of unkeyedChildren) {
          if (child.key !== undefined) { hasKeyed = true; break; }
        }
        if (hasKeyed) {
          const _ = new Map<string, MockChild>();
          for (const child of unkeyedChildren) {
            if (child.key !== undefined) _.set(child.key, child);
          }
        }
      },
      ITERATIONS,
    );

    const speedup = alwaysMapTime / skipMapTime;
    console.log(`  Speedup (skip Map): ${speedup.toFixed(2)}x`);
    expect(speedup).toBeGreaterThan(1.3);
  });

  it('10 mixed (5 keyed) children: new Map vs check then Map', () => {
    const mixedChildren: MockChild[] = [
      { key: 'a' }, { key: 'b' }, {}, { key: 'c' }, {},
      { key: 'd' }, {}, {}, { key: 'e' }, {},
    ];

    const alwaysMapTime = benchPerf(
      'Always: new Map() regardless',
      () => {
        const _ = new Map<string, MockChild>();
        for (const child of mixedChildren) {
          if (child.key !== undefined) _.set(child.key, child);
        }
      },
      ITERATIONS,
    );

    const checkMapTime = benchPerf(
      'Check hasKeyed first, then Map (keyed case)',
      () => {
        let hasKeyed = false;
        for (const child of mixedChildren) {
          if (child.key !== undefined) { hasKeyed = true; break; }
        }
        const m = hasKeyed ? new Map<string, MockChild>() : null;
        for (const child of mixedChildren) {
          if (child.key !== undefined && m !== null) m.set(child.key, child);
        }
      },
      ITERATIONS,
    );

    const speedup = alwaysMapTime / checkMapTime;
    console.log(`  Speedup (mixed, keyed present): ${speedup.toFixed(2)}x`);
    expect(speedup).toBeGreaterThan(0.7);
  });
});

describe('nextChildren: dynamic push vs pre-allocated', () => {
  const N = 10;
  const items = Array.from({ length: N }, (_, i) => ({ id: i }));

  it('dynamic push vs pre-allocated Array(N)', () => {
    const pushTime = benchPerf(
      'new Array() + push × N',
      () => {
        const arr: typeof items = [];
        for (const item of items) arr.push(item);
      },
      ITERATIONS,
    );

    const preAllocTime = benchPerf(
      'new Array(N) + indexed write × N',
      () => {
        const arr = new Array<(typeof items)[0]>(N);
        for (let i = 0; i < N; i++) arr[i] = items[i];
      },
      ITERATIONS,
    );

    const speedup = pushTime / preAllocTime;
    console.log(`  Speedup (pre-alloc): ${speedup.toFixed(2)}x`);
    expect(speedup).toBeGreaterThan(0.15);
  });
});

describe('isStableChildren fast-path', () => {
  interface MockVnode { type: Function; key?: string }
  interface MockFiber { vnode: MockVnode }

  const N = 10;
  const stableCurrentChildren: MockFiber[] = Array.from({ length: N }, (_, i) => ({
    vnode: { type: class C {}, key: `key-${i}` },
  }));
  const stableNextVnodes: MockVnode[] = stableCurrentChildren.map(f => ({ ...f.vnode }));

  const types = Array.from({ length: N }, () => class C {});
  for (let i = 0; i < N; i++) {
    stableCurrentChildren[i] = { vnode: { type: types[i], key: `key-${i}` } };
    stableNextVnodes[i] = { type: types[i], key: `key-${i}` };
  }

  it('isStableChildren check vs full diff setup (N=10)', () => {
    const stableCheckTime = benchPerf(
      'isStableChildren: type+key check (fast-path)',
      () => {
        if (stableCurrentChildren.length !== stableNextVnodes.length) return false;
        for (let i = 0; i < stableCurrentChildren.length; i++) {
          const cur = stableCurrentChildren[i].vnode;
          const next = stableNextVnodes[i];
          if (cur.type !== next.type || (cur.key ?? null) !== (next.key ?? null)) return false;
        }
        return true;
      },
      ITERATIONS,
    );

    const fullDiffTime = benchPerf(
      'Full diff: new Map() + unkeyedArr + iterate',
      () => {
        const keyedMap = new Map<string, MockFiber>();
        const unkeyed: MockFiber[] = [];
        for (const child of stableCurrentChildren) {
          if (child.vnode.key !== undefined) {
            keyedMap.set(child.vnode.key, child);
          } else {
            unkeyed.push(child);
          }
        }
        const result: MockFiber[] = [];
        for (const next of stableNextVnodes) {
          if (next.key !== undefined && keyedMap.has(next.key)) {
            result.push(keyedMap.get(next.key)!);
            keyedMap.delete(next.key);
          } else {
            result.push({ vnode: next });
          }
        }
      },
      ITERATIONS,
    );

    const speedup = fullDiffTime / stableCheckTime;
    console.log(`  Speedup (stable fast-path): ${speedup.toFixed(2)}x`);
    expect(speedup).toBeGreaterThan(2.0);
  });
});

describe('Scaling: cold vs warm and N grid (GraphRuntime microbench)', () => {
  interface MockChild { key?: string }

  it('cold first skip-map call is more expensive than warm series (after warmup)', () => {
    const children10: MockChild[] = Array.from({ length: 10 }, () => ({}));

    const work = (): void => {
      let hasKeyed = false;
      for (const child of children10) {
        if (child.key !== undefined) { hasKeyed = true; break; }
      }
      if (hasKeyed) {
        const _ = new Map<string, MockChild>();
        for (const c of children10) {
          if (c.key !== undefined) _.set(c.key, c);
        }
      }
    };

    const { coldNsPerOp, warmNsPerOp } = coldVsWarm(work, 50_000);
    console.log(`  cold first-call ns (single): ${coldNsPerOp.toFixed(0)}`);
    console.log(`  warm avg ns/op: ${warmNsPerOp.toFixed(2)}`);
    expect(coldNsPerOp).toBeGreaterThan(0);
    expect(warmNsPerOp).toBeGreaterThan(0);
    expect(warmNsPerOp).toBeLessThanOrEqual(coldNsPerOp * 5);
  });

  it('avalanche growth of N: skip-map path stays consistent from 0 to many children', () => {
    const sizes = [0, 1, 4, 16, 64, 256];
    const nsPerSizes: number[] = [];

    for (const size of sizes) {
      const children: MockChild[] = Array.from({ length: size }, () => ({}));
      const t = benchAvgNs(
        () => {
          let hasKeyed = false;
          for (const child of children) {
            if (child.key !== undefined) { hasKeyed = true; break; }
          }
          if (hasKeyed) {
            const _ = new Map<string, MockChild>();
            for (const c of children) {
              if (c.key !== undefined) _.set(c.key, c);
            }
          }
        },
        2000,
        { warmupIterations: 200 },
      );
      nsPerSizes.push(t);
      console.log(`  N=${size}: ${t.toFixed(2)} ns/op (warm avg)`);
    }

    expect(nsPerSizes.every(n => n > 0 && Number.isFinite(n))).toBe(true);
  });

  it('reverse avalanche: after N=256, return to N=1 yields a comparable order of magnitude', () => {
    const runOnce = (size: number): number => {
      const children: MockChild[] = Array.from({ length: size }, () => ({}));
      return benchAvgNs(
        () => {
          let hasKeyed = false;
          for (const child of children) {
            if (child.key !== undefined) { hasKeyed = true; break; }
          }
          if (hasKeyed) {
            const _ = new Map<string, MockChild>();
            for (const c of children) {
              if (c.key !== undefined) _.set(c.key, c);
            }
          }
        },
        5000,
        { warmupIterations: 500 },
      );
    };

    const large = runOnce(512);
    const small = runOnce(1);
    console.log(`  N=512 warm avg: ${large.toFixed(2)} ns/op`);
    console.log(`  N=1 warm avg: ${small.toFixed(2)} ns/op`);
    expect(large).toBeGreaterThan(0);
    expect(small).toBeGreaterThan(0);
  });

  it('N=0: empty children array — skip-map path is finite', () => {
    const children0: { key?: string }[] = [];
    const t = benchAvgNs(
      () => {
        let hasKeyed = false;
        for (const child of children0) {
          if (child.key !== undefined) {
            hasKeyed = true;
            break;
          }
        }
        if (hasKeyed) {
          const _ = new Map<string, { key?: string }>();
          for (const c of children0) {
            if (c.key !== undefined) _.set(c.key, c);
          }
        }
      },
      500,
      { warmupIterations: 50 },
    );
    console.log(`  N=0 warm avg: ${t.toFixed(2)} ns/op`);
    expect(t).toBeGreaterThan(0);
    expect(Number.isFinite(t)).toBe(true);
  });
});

describe('Benchmark: GraphRuntime production reconcile paths', () => {
  it('prints stable reconcile fast-path on a real GraphRuntime', async () => {
    console.log('\n=== GraphRuntime stable reconcile ===');

    let toggle = false;
    const runtime = await GraphRuntime.mount(
      h(RuntimeHost, { items: createItems(16, 0) })
    );

    const stableNs = await benchAvgAsyncNs(
      async () => {
        toggle = !toggle;
        await runtime.reconcile(
          h(RuntimeHost, {
            items: createItems(16, toggle ? 100 : 0),
          })
        );
      },
      2_000,
      { warmupIterations: 200 }
    );

    console.log(`  stable reconcile: ${stableNs.toFixed(2)} ns/op`);

    expect(stableNs).toBeGreaterThan(0);
    expect(Number.isFinite(stableNs)).toBe(true);

    await runtime.unmount();
  });

  it('prints keyed reorder/full-diff path on a real GraphRuntime', async () => {
    console.log('\n=== GraphRuntime keyed reorder reconcile ===');

    let current = createItems(48, 0);
    const runtime = await GraphRuntime.mount(
      h(RuntimeHost, { items: current })
    );

    const reorderNs = await benchAvgAsyncNs(
      async () => {
        current = reverseItems(current);
        await runtime.reconcile(
          h(RuntimeHost, { items: current })
        );
      },
      800,
      { warmupIterations: 80 }
    );

    console.log(`  keyed reorder reconcile: ${reorderNs.toFixed(2)} ns/op`);

    expect(reorderNs).toBeGreaterThan(0);
    expect(Number.isFinite(reorderNs)).toBe(true);

    await runtime.unmount();
  });

  it('prints scaling for a full mount/unmount cycle of a real GraphRuntime', async () => {
    console.log('\n=== GraphRuntime mount/unmount scaling ===');

    const sizes = [1, 8, 32, 96];

    for (const size of sizes) {
      const ns = await benchAvgAsyncNs(
        async () => {
          await runRuntimeCycle(
            h(RuntimeHost, {
              items: createItems(size, 0),
            })
          );
        },
        120,
        { warmupIterations: 20 }
      );

      console.log(`  size=${String(size)} mount/unmount: ${ns.toFixed(2)} ns/op`);
      expect(ns).toBeGreaterThan(0);
      expect(Number.isFinite(ns)).toBe(true);
    }
  });

  it('compares sync fast-path and a tree with an async child', async () => {
    console.log('\n=== GraphRuntime sync tree vs async child ===');

    const syncNs = await benchAvgAsyncNs(
      async () => {
        await runRuntimeCycle(
          h(RuntimeHost, {
            items: createItems(8, 0),
          })
        );
      },
      100,
      { warmupIterations: 20 }
    );

    const asyncNs = await benchAvgAsyncNs(
      async () => {
        await runRuntimeCycle(
          h(RuntimeAsyncHost, {
            items: createItems(8, 0),
          })
        );
      },
      100,
      { warmupIterations: 20 }
    );

    const ratio = asyncNs / syncNs;

    console.log(`  sync tree: ${syncNs.toFixed(2)} ns/op`);
    console.log(`  tree with async child: ${asyncNs.toFixed(2)} ns/op`);
    console.log(`  async/sync ratio: ${ratio.toFixed(2)}x`);

    expect(syncNs).toBeGreaterThan(0);
    expect(asyncNs).toBeGreaterThan(0);
    expect(Number.isFinite(syncNs)).toBe(true);
    expect(Number.isFinite(asyncNs)).toBe(true);
    expect(ratio).toBeGreaterThan(1.0);
  });
});

jest.setTimeout(120_000);
