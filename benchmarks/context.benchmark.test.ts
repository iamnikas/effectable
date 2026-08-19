/**
 * ContextScope and injectContextFields benchmarks.
 * Run: npx jest context.benchmark --testTimeout=120000
 */

/* eslint-disable no-console */

import { benchAvgNs, coldVsWarm } from './helpers/effectableBenchmarkHelpers';
import {
  Component,
  ContextProvider,
  EMPTY_CONTEXT_SCOPE,
  GraphRuntime,
  UseContext,
  createContext,
  extendScope,
  h,
  injectContextFields,
  readFromScope,
  type ContextScope,
  type ContextToken,
} from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

const ITERATIONS = 100_000;
const REAL_CONTEXT_TOKEN = createContext<string>('real_context_bench');

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

class RealPureContextComponent {}

class RealInjectedContextComponent {
  @UseContext(REAL_CONTEXT_TOKEN)
  public service = '';
}

interface ProviderLayerProps {
  depth: number;
  label: string;
}

class ContextLeafBenchmark extends Component<Record<string, never>, ProviderLayerProps> {
  @UseContext(REAL_CONTEXT_TOKEN)
  public service = '';

  constructor (props: ProviderLayerProps) {
    super(props);
    this.state = {};
  }

  public override onMount (): void {
    if (this.service.length === 0) {
      throw new Error('Expected injected context value in benchmark leaf');
    }
  }
}

class ContextProviderChainBenchmark extends Component<Record<string, never>, ProviderLayerProps> {
  constructor (props: ProviderLayerProps) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode[] {
    let tree: VirtualServiceNode = h(ContextLeafBenchmark, {
      depth: this.props.depth,
      label: this.props.label,
    });

    for (let level = 0; level < this.props.depth; level += 1) {
      tree = h(
        ContextProvider,
        {
          value: [REAL_CONTEXT_TOKEN, `${this.props.label}-${String(level)}`],
        },
        [tree]
      );
    }

    return [tree];
  }
}

/**
 * `extendScope` chain per pair — behavior before the applyToScope batch (slower: N full Map copies).
 */
function legacyApplyMultiPairs (
  parentScope: ContextScope,
  pairs: Array<[ContextToken<unknown>, unknown]>,
): ContextScope {
  let scope = parentScope;

  for (const pair of pairs) {
    const [token, val] = pair;
    scope = extendScope(scope, token, val);
  }

  return scope;
}

function scopesEqual (a: ContextScope, b: ContextScope): boolean {
  if (a.size !== b.size) {
    return false;
  }

  for (const [key, val] of a) {
    if (b.get(key) !== val) {
      return false;
    }
  }

  return true;
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

describe('Benchmark: applyToScope batch vs legacy extendScope chain', () => {
  const BENCH_TOKENS = {
    a: createContext<string>('bench_ctx_a'),
    b: createContext<number>('bench_ctx_b'),
    c: createContext<boolean>('bench_ctx_c'),
  } as const;

  const triplePairs: Array<[ContextToken<unknown>, unknown]> = [
    [BENCH_TOKENS.a, 'hello'],
    [BENCH_TOKENS.b, 42],
    [BENCH_TOKENS.c, true],
  ];

  const parentNonEmpty: ContextScope = extendScope(
    extendScope(EMPTY_CONTEXT_SCOPE, BENCH_TOKENS.a, 'parent-a'),
    BENCH_TOKENS.b,
    -1,
  );

  it('equivalence: legacy chain vs ContextProvider.applyToScope (empty and non-empty parent)', () => {
    const pEmpty = new ContextProvider({ value: triplePairs });
    const pParent = new ContextProvider({ value: triplePairs });

    const outLegacyEmpty = legacyApplyMultiPairs(EMPTY_CONTEXT_SCOPE, triplePairs);
    const outCurrentEmpty = pEmpty.applyToScope(EMPTY_CONTEXT_SCOPE);
    expect(scopesEqual(outLegacyEmpty, outCurrentEmpty)).toBe(true);
    expect(readFromScope(outCurrentEmpty, BENCH_TOKENS.a)).toBe('hello');
    expect(readFromScope(outCurrentEmpty, BENCH_TOKENS.b)).toBe(42);
    expect(readFromScope(outCurrentEmpty, BENCH_TOKENS.c)).toBe(true);

    const outLegacyParent = legacyApplyMultiPairs(parentNonEmpty, triplePairs);
    const outCurrentParent = pParent.applyToScope(parentNonEmpty);
    expect(scopesEqual(outLegacyParent, outCurrentParent)).toBe(true);
    expect(readFromScope(outCurrentParent, BENCH_TOKENS.a)).toBe('hello');
    expect(readFromScope(outCurrentParent, BENCH_TOKENS.b)).toBe(42);
    expect(readFromScope(outCurrentParent, BENCH_TOKENS.c)).toBe(true);
  });

  it('speedup: batch applyToScope vs extendScope chain (3 pairs)', () => {
    console.log('\n=== applyToScope batch (current code) vs legacy extendScope chain ===');

    const providerEmpty = new ContextProvider({ value: triplePairs });
    const providerParent = new ContextProvider({ value: triplePairs });

    const legacyEmptyNs = bench(
      'legacy: 3x extendScope (parent EMPTY)',
      () => {
        void legacyApplyMultiPairs(EMPTY_CONTEXT_SCOPE, triplePairs);
      },
      ITERATIONS,
    );

    const currentEmptyNs = bench(
      'current: applyToScope (parent EMPTY)',
      () => {
        void providerEmpty.applyToScope(EMPTY_CONTEXT_SCOPE);
      },
      ITERATIONS,
    );

    const speedupEmpty = legacyEmptyNs / currentEmptyNs;

    console.log(`  Speedup empty parent: ${speedupEmpty.toFixed(2)}x (legacy ns / current ns)`);

    const legacyParentNs = bench(
      'legacy: 3x extendScope (parent with 2 keys)',
      () => {
        void legacyApplyMultiPairs(parentNonEmpty, triplePairs);
      },
      ITERATIONS,
    );

    const currentParentNs = bench(
      'current: applyToScope (parent with 2 keys)',
      () => {
        void providerParent.applyToScope(parentNonEmpty);
      },
      ITERATIONS,
    );

    const speedupParent = legacyParentNs / currentParentNs;

    console.log(`  Speedup non-empty parent: ${speedupParent.toFixed(2)}x`);

    expect(speedupEmpty).toBeGreaterThan(1.2);
    expect(speedupParent).toBeGreaterThan(1.2);
  });
});

describe('Benchmark: ContextScope new Map vs Object.create', () => {
  const token1 = Symbol('token1');
  const token2 = Symbol('token2');
  const token3 = Symbol('token3');

  it('extendScope: new Map(parent) vs Object.create(parent)', () => {
    console.log('\n=== ContextScope extendScope ===');

    const parentMap = new Map<symbol, unknown>([[token1, 'v1'], [token2, 'v2']]);
    const newMapTime = bench(
      'new Map(parentScope) + set',
      () => {
        const child = new Map(parentMap);
        child.set(token3, 'v3');
      },
      ITERATIONS,
    );

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
    expect(speedup).toBeGreaterThan(1.0);
  });

  it('readFromScope: map.get vs prototype chain lookup', () => {
    console.log('\n=== ContextScope readFromScope ===');

    const scopeMap = new Map<symbol, unknown>([[token1, 'v1'], [token2, 'v2'], [token3, 'v3']]);
    const mapReadTime = bench(
      'Map.has + Map.get',
      () => {
        if (scopeMap.has(token2)) {
          const _v = scopeMap.get(token2);
          void _v;
        }
      },
      ITERATIONS,
    );

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
          void _v;
        }
      },
      ITERATIONS,
    );

    const ratio = protoReadTime / mapReadTime;

    console.log(`  Read ratio (proto vs Map): ${ratio.toFixed(2)}x`);
    expect(ratio).toBeLessThan(3.0);
  });
});

describe('Benchmark: instanceof vs Symbol prototype flag', () => {
  const IS_CONTEXT_PROVIDER = Symbol('isContextProvider');

  class BaseClass {}

  class ContextProvider extends BaseClass {}
  (ContextProvider.prototype as Record<symbol, unknown>)[IS_CONTEXT_PROVIDER] = true;

  const providerInstance = new ContextProvider();
  const baseInstance = new BaseClass();

  it('instanceof vs symbol flag check', () => {
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
    expect(ratio).toBeLessThan(2.0);
  });

  it('instanceof vs symbol flag check (negative — base class)', () => {
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

describe('instanceof ContextProvider vs Symbol flag', () => {
  const IS_CONTEXT_PROVIDER = Symbol('effectable:is_context_provider');

  class BaseComponent {}

  class ContextProvider extends BaseComponent {
    constructor () {
      super();
    }
  }
  (ContextProvider.prototype as Record<symbol, unknown>)[IS_CONTEXT_PROVIDER] = true;

  class RegularComponent extends BaseComponent {}

  function benchPerf (label: string, fn: () => void, n: number): number {
    const start = performance.now();
    for (let i = 0; i < n; i++) fn();
    const elapsed = (performance.now() - start) * 1_000_000;
    const nsPerOp = elapsed / n;
    console.log(`  ${label}: ${nsPerOp.toFixed(2)} ns/op`);
    return nsPerOp;
  }

  it('positive case: ContextProvider instance check', () => {
    const providerInstance = new ContextProvider();

    const instanceofTime = benchPerf(
      'instanceof ContextProvider (positive)',
      () => {
        const _ = providerInstance instanceof ContextProvider;
        void _;
      },
      ITERATIONS,
    );

    const symbolFlagTime = benchPerf(
      'Symbol flag check (positive)',
      () => {
        const _ = (providerInstance as Record<symbol, unknown>)[IS_CONTEXT_PROVIDER] === true;
        void _;
      },
      ITERATIONS,
    );

    const speedup = instanceofTime / symbolFlagTime;
    console.log(`  Speedup (Symbol flag vs instanceof): ${speedup.toFixed(2)}x`);
    expect(speedup).toBeGreaterThan(1.0);
  });

  it('negative case: RegularComponent (most common in hot path)', () => {
    const regularInstance = new RegularComponent();

    const instanceofTime = benchPerf(
      'instanceof ContextProvider (negative — most common)',
      () => {
        const _ = regularInstance instanceof ContextProvider;
        void _;
      },
      ITERATIONS,
    );

    const symbolFlagTime = benchPerf(
      'Symbol flag check (negative — most common)',
      () => {
        const _ = (regularInstance as Record<symbol, unknown>)[IS_CONTEXT_PROVIDER] === true;
        void _;
      },
      ITERATIONS,
    );

    const speedup = instanceofTime / symbolFlagTime;
    console.log(`  Speedup (negative case): ${speedup.toFixed(2)}x`);
    expect(speedup).toBeGreaterThan(0.8);
  });
});

describe('injectContextFields no-context fast-path', () => {
  const CONTEXT_FIELDS_META_KEY = Symbol('effectable:context_fields');
  const HAS_CONTEXT_FIELDS_KEY = Symbol('effectable:has_context_fields');

  interface ContextFieldMeta {
    propertyKey: string;
    token: {
      key: symbol;
      displayName: string;
      defaultValue: undefined;
    };
  }

  class PureComponent {}
  const pureConstructor = PureComponent as unknown as {
    [key: symbol]: unknown;
  };
  delete (pureConstructor as Record<symbol, unknown>)[HAS_CONTEXT_FIELDS_KEY];
  delete (pureConstructor as Record<symbol, unknown>)[CONTEXT_FIELDS_META_KEY];

  class ContextComponent {}
  const ctxConstructor = ContextComponent as unknown as Record<symbol, unknown>;
  const mockToken = Symbol('test-token');
  const mockScope = new Map<symbol, unknown>([[mockToken, 'value']]);
  ctxConstructor[HAS_CONTEXT_FIELDS_KEY] = true;
  ctxConstructor[CONTEXT_FIELDS_META_KEY] = [
    { propertyKey: 'service', token: { key: mockToken, displayName: 'test', defaultValue: undefined } },
  ] as ContextFieldMeta[];

  function benchPerf (label: string, fn: () => void, n: number): number {
    const start = performance.now();
    for (let i = 0; i < n; i++) fn();
    const elapsed = (performance.now() - start) * 1_000_000;
    const nsPerOp = elapsed / n;
    console.log(`  ${label}: ${nsPerOp.toFixed(2)} ns/op`);
    return nsPerOp;
  }

  it('no-context component: original vs optimized (fast-path)', () => {
    const pureInstance = new PureComponent();

    const originalTime = benchPerf(
      'Original: constructor[CONTEXT_FIELDS_META_KEY] ?? [] + loop (always)',
      () => {
        const fields = (pureConstructor[CONTEXT_FIELDS_META_KEY] as ContextFieldMeta[] | undefined) ?? [];
        for (const meta of fields) {
          void meta;
        }
      },
      ITERATIONS,
    );

    const optimizedTime = benchPerf(
      'Optimized: if (!HAS_CONTEXT_FIELDS_KEY) return (fast-exit)',
      () => {
        if (!pureConstructor[HAS_CONTEXT_FIELDS_KEY]) return;
        const fields = pureConstructor[CONTEXT_FIELDS_META_KEY] as ContextFieldMeta[];
        for (const meta of fields) {
          (pureInstance as Record<string, unknown>)[meta.propertyKey] = 'value';
        }
      },
      ITERATIONS,
    );

    const speedup = originalTime / optimizedTime;
    console.log(`  Speedup (no-context fast-exit): ${speedup.toFixed(2)}x`);
    expect(speedup).toBeGreaterThan(0.7);
  });

  it('context component: original vs optimized (same path, negligible diff)', () => {
    const ctxInstance = new ContextComponent();

    const originalTime = benchPerf(
      'Original: always access constructor fields + iterate',
      () => {
        const fields = (ctxConstructor[CONTEXT_FIELDS_META_KEY] as ContextFieldMeta[] | undefined) ?? [];
        for (const meta of fields) {
          (ctxInstance as Record<string, unknown>)[meta.propertyKey] = mockScope.get(meta.token.key) as string;
        }
      },
      ITERATIONS,
    );

    const optimizedTime = benchPerf(
      'Optimized: HAS check + iterate (1 extra check)',
      () => {
        if (!ctxConstructor[HAS_CONTEXT_FIELDS_KEY]) return;
        const fields = ctxConstructor[CONTEXT_FIELDS_META_KEY] as ContextFieldMeta[];
        for (const meta of fields) {
          (ctxInstance as Record<string, unknown>)[meta.propertyKey] = mockScope.get(meta.token.key) as string;
        }
      },
      ITERATIONS,
    );

    const speedup = originalTime / optimizedTime;
    console.log(`  Speedup (with-context): ${speedup.toFixed(2)}x`);
    expect(speedup).toBeGreaterThan(0.8);
  });
});

describe('Full materialize loop', () => {
  const CONTEXT_FIELDS_META_KEY = Symbol('effectable:context_fields_loop');
  const HAS_CONTEXT_FIELDS_KEY = Symbol('effectable:has_context_fields_loop');

  interface ContextFieldMetaLoop { propertyKey: string; token: { key: symbol } }

  const N = 1000;
  const CONTEXT_RATIO = 0.2;
  const mockToken = Symbol('loop-token');
  const mockScope = new Map<symbol, unknown>([[mockToken, 'val']]);

  const constructors = Array.from({ length: N }, (_, i) => {
    const c: Record<symbol, unknown> = {};
    if (i < N * CONTEXT_RATIO) {
      c[HAS_CONTEXT_FIELDS_KEY] = true;
      c[CONTEXT_FIELDS_META_KEY] = [{ propertyKey: 'svc', token: { key: mockToken } }] as ContextFieldMetaLoop[];
    }
    return c;
  });

  const instances = Array.from({ length: N }, () => ({} as Record<string, unknown>));

  function benchPerf (label: string, fn: () => void, n: number): number {
    const start = performance.now();
    for (let i = 0; i < n; i++) fn();
    const elapsed = (performance.now() - start) * 1_000_000;
    const nsPerOp = elapsed / n;
    console.log(`  ${label}: ${nsPerOp.toFixed(2)} ns/op`);
    return nsPerOp;
  }

  it('original vs optimized injectContextFields (N=1000, 80% pure)', () => {
    const origTime = benchPerf(
      'Original: always access CONTEXT_FIELDS_META_KEY + loop (N=1000)',
      () => {
        for (let i = 0; i < N; i++) {
          const fields = (constructors[i][CONTEXT_FIELDS_META_KEY] as ContextFieldMetaLoop[] | undefined) ?? [];
          for (const meta of fields) {
            instances[i][meta.propertyKey] = mockScope.get(meta.token.key);
          }
        }
      },
      1000,
    );

    const optTime = benchPerf(
      'Optimized: HAS check + early return for pure (N=1000)',
      () => {
        for (let i = 0; i < N; i++) {
          if (!constructors[i][HAS_CONTEXT_FIELDS_KEY]) continue;
          const fields = constructors[i][CONTEXT_FIELDS_META_KEY] as ContextFieldMetaLoop[];
          for (const meta of fields) {
            instances[i][meta.propertyKey] = mockScope.get(meta.token.key);
          }
        }
      },
      1000,
    );

    const speedup = origTime / optTime;
    console.log(`  Speedup (full loop N=1000, 80% pure): ${speedup.toFixed(2)}x`);
    expect(speedup).toBeGreaterThan(1.1);
  });

  it('small / medium / huge N: inject loop (optimized path)', () => {
    const scales = [
      { label: 'small', n: 10 },
      { label: 'medium', n: 2000 },
      { label: 'huge', n: 20_000 },
    ];

    for (const { label, n } of scales) {
      const constructorsN = Array.from({ length: n }, (_, i) => {
        const c: Record<symbol, unknown> = {};
        if (i < n * CONTEXT_RATIO) {
          c[HAS_CONTEXT_FIELDS_KEY] = true;
          c[CONTEXT_FIELDS_META_KEY] = [{ propertyKey: 'svc', token: { key: mockToken } }] as ContextFieldMetaLoop[];
        }
        return c;
      });
      const inst = Array.from({ length: n }, () => ({} as Record<string, unknown>));

      const t = benchAvgNs(
        () => {
          for (let i = 0; i < n; i++) {
            if (!constructorsN[i][HAS_CONTEXT_FIELDS_KEY]) continue;
            const fields = constructorsN[i][CONTEXT_FIELDS_META_KEY] as ContextFieldMetaLoop[];
            for (const meta of fields) {
              inst[i][meta.propertyKey] = mockScope.get(meta.token.key);
            }
          }
        },
        50,
        { warmupIterations: 5 },
      );
      console.log(`  ${label} N=${n}: ${t.toFixed(0)} ns/op (full loop one pass, warm)`);
      expect(t).toBeGreaterThan(0);
    }
  });

  it('cold vs warm: full injection cycle N=5000', () => {
    const n = 5000;
    const constructorsN = Array.from({ length: n }, (_, i) => {
      const c: Record<symbol, unknown> = {};
      if (i < n * CONTEXT_RATIO) {
        c[HAS_CONTEXT_FIELDS_KEY] = true;
        c[CONTEXT_FIELDS_META_KEY] = [{ propertyKey: 'svc', token: { key: mockToken } }] as ContextFieldMetaLoop[];
      }
      return c;
    });
    const inst = Array.from({ length: n }, () => ({} as Record<string, unknown>));

    const work = (): void => {
      for (let i = 0; i < n; i++) {
        if (!constructorsN[i][HAS_CONTEXT_FIELDS_KEY]) continue;
        const fields = constructorsN[i][CONTEXT_FIELDS_META_KEY] as ContextFieldMetaLoop[];
        for (const meta of fields) {
          inst[i][meta.propertyKey] = mockScope.get(meta.token.key);
        }
      }
    };

    const { coldNsPerOp, warmNsPerOp } = coldVsWarm(work, 100);
    console.log(`  cold single-pass total ns: ${coldNsPerOp.toFixed(0)}`);
    console.log(`  warm avg ns/op (inner): ${warmNsPerOp.toFixed(2)}`);
    expect(coldNsPerOp).toBeGreaterThan(0);
  });
});

describe('Benchmark: prototype depth 0 vs 3 (read)', () => {
  const tokenLeaf = Symbol('leafTok');

  function benchLocal (name: string, fn: () => void, iterations: number): number {
    for (let i = 0; i < Math.min(1000, iterations / 10); i++) {
      fn();
    }
    const start = process.hrtime.bigint();
    for (let i = 0; i < iterations; i++) {
      fn();
    }
    const end = process.hrtime.bigint();
    return Number(end - start) / iterations;
  }

  it('flat object vs prototype chain of depth 3 — both measurements are finite', () => {
    const flat: Record<symbol, unknown> = Object.create(null);
    flat[tokenLeaf] = 'flat';

    let chain: Record<symbol, unknown> = Object.create(null);
    chain[tokenLeaf] = 'root';
    for (let d = 0; d < 3; d++) {
      chain = Object.create(chain) as Record<symbol, unknown>;
    }
    chain[tokenLeaf] = 'leaf';

    const flatNs = benchLocal(
      'flat: token in obj',
      () => {
        if (tokenLeaf in flat) {
          void flat[tokenLeaf];
        }
      },
      50_000,
    );

    const chainNs = benchLocal(
      'depth3: token in obj',
      () => {
        if (tokenLeaf in chain) {
          void chain[tokenLeaf];
        }
      },
      50_000,
    );

    console.log(`  flat ns/op: ${flatNs.toFixed(1)}, depth3 ns/op: ${chainNs.toFixed(1)}`);
    expect(flatNs).toBeGreaterThan(0);
    expect(chainNs).toBeGreaterThan(0);
    expect(Number.isFinite(flatNs)).toBe(true);
    expect(Number.isFinite(chainNs)).toBe(true);
    expect(chainNs / flatNs).toBeLessThan(25);
  });
});

describe('Benchmark: context production API paths', () => {
  it('prints a real injectContextFields loop for 80% pure components', () => {
    console.log('\n=== injectContextFields real API loop ===');

    const instances: object[] = [];
    for (let i = 0; i < 800; i += 1) {
      instances.push(new RealPureContextComponent());
    }
    for (let i = 0; i < 200; i += 1) {
      instances.push(new RealInjectedContextComponent());
    }

    const scope = extendScope(EMPTY_CONTEXT_SCOPE, REAL_CONTEXT_TOKEN, 'bench-service');
    const ns = benchAvgNs(
      () => {
        for (let i = 0; i < instances.length; i += 1) {
          injectContextFields(instances[i], scope);
        }
      },
      1_000,
      { warmupIterations: 100 }
    );

    console.log(`  injectContextFields real loop (N=1000): ${ns.toFixed(2)} ns/op`);

    expect(ns).toBeGreaterThan(0);
    expect(Number.isFinite(ns)).toBe(true);
  });

  it('prints GraphRuntime mount/unmount for a deep ContextProvider chain', async () => {
    console.log('\n=== ContextProvider chain mount/unmount ===');

    for (const depth of [1, 4, 16]) {
      const ns = await benchAvgAsyncNs(
        async () => {
          const runtime = await GraphRuntime.mount(
            h(ContextProviderChainBenchmark, {
              depth,
              label: 'provider-chain',
            })
          );
          await runtime.unmount();
        },
        100,
        { warmupIterations: 20 }
      );

      console.log(`  provider depth=${String(depth)}: ${ns.toFixed(2)} ns/op`);
      expect(ns).toBeGreaterThan(0);
      expect(Number.isFinite(ns)).toBe(true);
    }
  });
});

describe('Benchmark: #15 updateFiber scope-identity skip', () => {
  const UPDATE_CONTEXT_TOKEN = createContext<number>('update_bench_ctx');

  class UpdateConsumer extends Component<{ count: number }, Record<string, never>> {
    @UseContext(UPDATE_CONTEXT_TOKEN)
    public contextValue = -1;

    constructor () {
      super({}, { count: 0 });
    }

    public increment (): void {
      this.setState({ count: this.state.count + 1 });
    }

    public override onUpdate (): void {
      void this.state.count;
    }
  }

  const N_CONSUMERS = 32;
  const STABLE_CONSUMER_PROPS = {};

  class UpdateBenchRootA extends Component<Record<string, never>, { dummyProp: number }> {
    private consumerRefs: Array<RefObject<UpdateConsumer>> = [];

    constructor (props: { dummyProp: number }) {
      super(props);
      for (let i = 0; i < N_CONSUMERS; i++) {
        this.consumerRefs.push({ current: null });
      }
    }

    public override compose (): VirtualServiceNode[] {
      const consumers: VirtualServiceNode[] = [];
      for (let i = 0; i < N_CONSUMERS; i++) {
        consumers.push(h(UpdateConsumer, STABLE_CONSUMER_PROPS, this.consumerRefs[i], `consumer-${String(i)}`));
      }

      return [
        h(ContextProvider, { value: [UPDATE_CONTEXT_TOKEN, 100] }, consumers),
      ];
    }

    public triggerConsumerStateUpdates (): void {
      for (const ref of this.consumerRefs) {
        ref.current?.increment();
      }
    }
  }

  class UpdateBenchRootB extends Component<Record<string, never>, { providerValue: number }> {
    constructor (props: { providerValue: number }) {
      super(props);
    }

    public override compose (): VirtualServiceNode[] {
      const consumers: VirtualServiceNode[] = [];
      for (let i = 0; i < N_CONSUMERS; i++) {
        consumers.push(h(UpdateConsumer, STABLE_CONSUMER_PROPS, `consumer-${String(i)}`));
      }

      return [
        h(ContextProvider, { value: [UPDATE_CONTEXT_TOKEN, this.props.providerValue] }, consumers),
      ];
    }
  }

  it('A: props-only reconcile (same scope identity)', async () => {
    console.log('\n=== Benchmark: #15 updateFiber scope-identity skip ===');

    const runtime = await GraphRuntime.mount(
      h(UpdateBenchRootA, { dummyProp: 0 })
    );

    const root = runtime.getRootInstance() as UpdateBenchRootA;

    const nsA = benchAvgNs(
      () => {
        root.triggerConsumerStateUpdates();
      },
      500,
      { warmupIterations: 50 }
    );

    console.log(`  A: props-only reconcile (same scope, ${N_CONSUMERS} consumers): ${nsA.toFixed(2)} ns/op`);

    await runtime.unmount();

    expect(nsA).toBeGreaterThan(0);
    expect(Number.isFinite(nsA)).toBe(true);
  });

  it('B: provider value change (new scope, reused consumers)', async () => {
    const runtime = await GraphRuntime.mount(
      h(UpdateBenchRootB, { providerValue: 100 })
    );

    let nextValue = 101;
    const nsB = await benchAvgAsyncNs(
      async () => {
        await runtime.reconcile(h(UpdateBenchRootB, { providerValue: nextValue }));
        nextValue += 1;
      },
      500,
      { warmupIterations: 50 }
    );

    console.log(`  B: provider value change (new scope, ${N_CONSUMERS} consumers): ${nsB.toFixed(2)} ns/op`);

    await runtime.unmount();

    expect(nsB).toBeGreaterThan(0);
    expect(Number.isFinite(nsB)).toBe(true);
  });

  it('C: compare A vs B (A should be faster)', async () => {
    const runtimeA = await GraphRuntime.mount(
      h(UpdateBenchRootA, { dummyProp: 0 })
    );

    const rootA = runtimeA.getRootInstance() as UpdateBenchRootA;

    const nsA = benchAvgNs(
      () => {
        rootA.triggerConsumerStateUpdates();
      },
      500,
      { warmupIterations: 50 }
    );

    await runtimeA.unmount();

    const runtimeB = await GraphRuntime.mount(
      h(UpdateBenchRootB, { providerValue: 100 })
    );

    let nextValue = 101;
    const nsB = await benchAvgAsyncNs(
      async () => {
        await runtimeB.reconcile(h(UpdateBenchRootB, { providerValue: nextValue }));
        nextValue += 1;
      },
      500,
      { warmupIterations: 50 }
    );

    await runtimeB.unmount();

    const ratio = nsB / nsA;
    console.log(`  Ratio B/A: ${ratio.toFixed(2)}x (B should be slower, ratio > 1.0)`);

    expect(ratio).toBeGreaterThan(1.0);
    expect(nsA).toBeGreaterThan(0);
    expect(nsB).toBeGreaterThan(0);
  });
});

jest.setTimeout(120_000);
