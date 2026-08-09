/**
 * Benchmark: GraphRuntime component/ optimization candidates
 *
 * Measures:
 * 1. Map allocation vs clear+reuse — baseline difference
 * 2. Object.create vs new Map for ContextScope
 * 3. isStableChildren fast-path vs full diff simulation
 * 4. typeof check vs cached flag
 *
 * Run: npx jest reconcile-allocations.benchmark --testTimeout=30000
 */

/* eslint-disable no-console */

const ITERATIONS = 100_000;
const TREE_SIZE = 10; // typical HFT tree

// ---------------------------------------------------------------------------
// Benchmark utilities
// ---------------------------------------------------------------------------

function bench(name: string, fn: () => void, iterations: number): number {
  // warmup
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

// ---------------------------------------------------------------------------
// 1. Map allocation vs clear+reuse
// ---------------------------------------------------------------------------

describe('Benchmark: Map allocation vs clear+reuse', () => {
  test('new Map() vs existingMap.clear()', () => {
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

    // Pre-allocated map
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
    expect(speedup).toBeGreaterThan(1.5); // expect at least 1.5x improvement
  });
});

// ---------------------------------------------------------------------------
// 2. ContextScope: new Map vs Object.create
// ---------------------------------------------------------------------------

describe('Benchmark: ContextScope new Map vs Object.create', () => {
  const token1 = Symbol('token1');
  const token2 = Symbol('token2');
  const token3 = Symbol('token3');

  test('extendScope: new Map(parent) vs Object.create(parent)', () => {
    console.log('\n=== ContextScope extendScope ===');

    // Simulate current: new Map(parentScope)
    const parentMap = new Map<symbol, unknown>([[token1, 'v1'], [token2, 'v2']]);
    const newMapTime = bench(
      'new Map(parentScope) + set',
      () => {
        const child = new Map(parentMap);
        child.set(token3, 'v3');
      },
      ITERATIONS,
    );

    // Optimized: Object.create
    const parentObj: Record<symbol, unknown> = Object.create(null);
    parentObj[token1] = 'v1';
    parentObj[token2] = 'v2';
    const objCreateTime = bench(
      'Object.create(parentScope) + assign',
      () => {
        const child = Object.create(parentObj) as Record<symbol, unknown>;
        child[token3] = 'v3';
      },
      ITERATIONS,
    );

    const speedup = newMapTime / objCreateTime;

    console.log(`  Speedup (new Map vs Object.create): ${speedup.toFixed(1)}x`);
    expect(speedup).toBeGreaterThan(1.0); // at least not slower
  });

  test('readFromScope: map.get vs prototype chain lookup', () => {
    console.log('\n=== ContextScope readFromScope ===');

    // Map lookup
    const scopeMap = new Map<symbol, unknown>([[token1, 'v1'], [token2, 'v2'], [token3, 'v3']]);
    const mapReadTime = bench(
      'Map.has + Map.get',
      () => {
        if (scopeMap.has(token2)) {
          const _v = scopeMap.get(token2);
        }
      },
      ITERATIONS,
    );

    // Prototype chain lookup
    const level0: Record<symbol, unknown> = Object.create(null);
    level0[token1] = 'v1';
    const level1 = Object.create(level0) as Record<symbol, unknown>;
    level1[token2] = 'v2';
    const level2 = Object.create(level1) as Record<symbol, unknown>;
    level2[token3] = 'v3';

    const protoReadTime = bench(
      'key in obj (prototype chain depth=2)',
      () => {
        if (token2 in level2) {
          const _v = (level2 as Record<symbol, unknown>)[token2];
        }
      },
      ITERATIONS,
    );

    const ratio = protoReadTime / mapReadTime;

    console.log(`  Read ratio (proto vs Map): ${ratio.toFixed(2)}x (proto is ${ratio < 1 ? 'faster' : 'slower'})`);
    // Prototype chain may be slightly slower at depth=2, but within 3x
    expect(ratio).toBeLessThan(3.0);
  });
});

// ---------------------------------------------------------------------------
// 3. isStableChildren fast-path
// ---------------------------------------------------------------------------

describe('Benchmark: isStableChildren fast-path vs full diff setup', () => {
  class MockComponent {}

  // Simulate RuntimeFiber with type info
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

  test('stable children check vs Map construction', () => {
    console.log('\n=== isStableChildren vs Map construction ===');

    const current = makeCurrentFibers(TREE_SIZE);
    const next = makeNextVnodes(TREE_SIZE);

    // Full diff: build keyedMap
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
        // Simulate iterate
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

    // isStableChildren check + indexed loop
    const stableCheckTime = bench(
      `Stable check: isStable + indexed loop (N=${TREE_SIZE})`,
      () => {
        // isStableChildren
        let stable = current.length === next.length && current.length <= 32;
        if (stable) {
          for (let i = 0; i < current.length && stable; i++) {
            if (current[i]!.vnode.type !== next[i]!.type) stable = false;
            if ((current[i]!.vnode.key ?? null) !== (next[i]!.key ?? null)) stable = false;
          }
        }

        if (stable) {
          // fast path: indexed loop (no Map)
          const result: unknown[] = new Array(next.length);
          for (let i = 0; i < next.length; i++) {
            result[i] = next[i]; // simulate reconcile work
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

// ---------------------------------------------------------------------------
// 4. typeof hook check vs cached flags
// ---------------------------------------------------------------------------

describe('Benchmark: typeof hook check vs cached boolean flags', () => {
  const componentWithHooks = {
    onMount(): void {},
    onUpdate(): void {},
    onUnmount(): void {},
  };

  const componentNoHooks = {
    // No hooks
  };

  test('typeof check vs pre-computed flags', () => {
    console.log('\n=== typeof hook checks vs cached flags ===');

    // Current: typeof on each check
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

    // Cached: pre-compute at LifecycleEngine creation
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
    // On different machines the gap may be modest; pin a minimum cache win
    expect(speedup).toBeGreaterThan(1.05);
  });

  test('typeof check for component WITHOUT hooks', () => {
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

// ---------------------------------------------------------------------------
// 5. instanceof vs Symbol prototype flag
// ---------------------------------------------------------------------------

describe('Benchmark: instanceof vs Symbol prototype flag for ContextProvider detection', () => {
  const IS_CONTEXT_PROVIDER = Symbol('isContextProvider');

  class BaseClass {}

  class ContextProvider extends BaseClass {}
  (ContextProvider.prototype as Record<symbol, unknown>)[IS_CONTEXT_PROVIDER] = true;

  const providerInstance = new ContextProvider();
  const baseInstance = new BaseClass();

  test('instanceof vs symbol flag check', () => {
    console.log('\n=== instanceof vs Symbol flag ===');

    const instanceofTime = bench(
      'instanceof ContextProvider (positive)',
      () => {
        const result = providerInstance instanceof ContextProvider;
        void result;
      },
      ITERATIONS,
    );

    const symbolFlagTime = bench(
      'Symbol prototype flag check (positive)',
      () => {
        const result = (providerInstance as Record<symbol, unknown>)[IS_CONTEXT_PROVIDER] === true;
        void result;
      },
      ITERATIONS,
    );

    const ratio = symbolFlagTime / instanceofTime;

    console.log(`  Ratio (symbol vs instanceof): ${ratio.toFixed(2)}x`);
    // Symbol flag should be at least comparable
    expect(ratio).toBeLessThan(2.0);
  });

  test('instanceof vs symbol flag check (negative — base class)', () => {
    console.log('\n  Negative case:');

    const instanceofNegTime = bench(
      'instanceof ContextProvider (negative)',
      () => {
        const result = baseInstance instanceof ContextProvider;
        void result;
      },
      ITERATIONS,
    );

    const symbolNegTime = bench(
      'Symbol flag check (negative)',
      () => {
        const result = (baseInstance as Record<symbol, unknown>)[IS_CONTEXT_PROVIDER] === true;
        void result;
      },
      ITERATIONS,
    );

    console.log(`  instanceof neg: ${instanceofNegTime.toFixed(1)} ns/op, symbol neg: ${symbolNegTime.toFixed(1)} ns/op`);
    expect(instanceofNegTime).toBeDefined();
    expect(symbolNegTime).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Final summary test
// ---------------------------------------------------------------------------

describe('Benchmark Summary', () => {
  test('print summary of optimizations', () => {
    console.log('\n=== FINAL OPTIMIZATION SUMMARY ===');
    console.log('All benchmarks completed.');
    console.log('Expected improvements:');
    console.log('  1. Map.clear() vs new Map(): expect 5-15x');
    console.log('  2. Object.create vs new Map for scope: expect 3-8x speedup');
    console.log('  3. isStableChildren fast-path: expect 2-5x for stable trees');
    console.log('  4. Cached hook flags: expect 3-10x vs typeof');
    console.log('  5. Symbol flag vs instanceof: expect ~equal or slightly faster');
    expect(true).toBe(true);
  });
});
