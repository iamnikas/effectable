/**
 * Lifecycle stage simulation benchmarks.
 * Run: npx jest lifecycle.benchmark --testTimeout=120000
 */

/* eslint-disable no-console */

import { benchAvgNs, coldVsWarm } from './helpers/effectableBenchmarkHelpers';
import { Component, LifecycleEngine } from 'Effectable';

const ITERATIONS = 100_000;

async function benchAvgAsyncNs (
  fn: () => Promise<void>,
  iterations: number,
  options?: { warmupIterations?: number },
): Promise<number> {
  const warmup = options?.warmupIterations ?? Math.min(200, Math.max(1, Math.floor(iterations / 10)));

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

class NoHooksLifecycleComponent extends Component<Record<string, never>, Record<string, never>> {
  constructor () {
    super({});
    this.state = {};
  }
}

class SyncHooksLifecycleComponent extends Component<Record<string, never>, Record<string, never>> {
  constructor () {
    super({});
    this.state = {};
  }

  public override onMount (): void {}

  public override onUnmount (): void {}
}

class AsyncHooksLifecycleComponent extends Component<Record<string, never>, Record<string, never>> {
  constructor () {
    super({});
    this.state = {};
  }

  public override async onMount (): Promise<void> {
    await Promise.resolve();
  }

  public override async onUnmount (): Promise<void> {
    await Promise.resolve();
  }
}

class FailedLifecycleComponent extends Component<Record<string, never>, Record<string, never>> {
  constructor () {
    super({});
    this.state = {};
  }

  public override onMount (): void {
    throw new Error('lifecycle benchmark failure');
  }

  public override onUnmount (): void {}
}

function createInitializedEngine (
  instance: Component<Record<string, never>, Record<string, never>>,
): LifecycleEngine {
  const engine = new LifecycleEngine();
  engine.initHookFlags(instance);
  return engine;
}

function bench (label: string, fn: () => void, n: number): number {
  const start = performance.now();
  for (let i = 0; i < n; i++) fn();
  const elapsed = (performance.now() - start) * 1_000_000;
  const nsPerOp = elapsed / n;
  console.log(`  ${label}: ${nsPerOp.toFixed(2)} ns/op`);
  return nsPerOp;
}

describe('STAGE_ORDER lookup vs numeric comparison', () => {
  const STAGE_ORDER_STR: Record<string, number> = {
    registered: 0, resolved: 1, created: 2, mounted: 3,
    ready: 4, unmounting: 5, unmounted: 6, destroyed: 7, failed: 8,
  };

  const STAGE = {
    Registered: 0, Resolved: 1, Created: 2, Mounted: 3,
    Ready: 4, Unmounting: 5, Unmounted: 6, Destroyed: 7, Failed: 8,
  } as const;

  it('canTransitionTo: string STAGE_ORDER lookup vs numeric compare', () => {
    let currentStatusStr = 'ready';
    let currentStage = STAGE.Ready;
    const targetStr = 'unmounting';
    const targetNum = STAGE.Unmounting;

    const strTime = bench(
      'STAGE_ORDER[target] > STAGE_ORDER[current] (2 string lookups)',
      () => {
        const _ = STAGE_ORDER_STR[targetStr] > STAGE_ORDER_STR[currentStatusStr];
        void _;
      },
      ITERATIONS,
    );

    const numTime = bench(
      'targetNum > currentStage (numeric compare)',
      () => {
        const _ = targetNum > currentStage;
        void _;
      },
      ITERATIONS,
    );

    const speedup = strTime / numTime;
    console.log(`  Speedup: ${speedup.toFixed(2)}x`);
    expect(speedup).toBeGreaterThan(0.3);
  });

  it('runShutdown: 4 STAGE_ORDER lookups vs 2 numeric compares', () => {
    let currentStatusStr = 'ready';
    let currentStage = STAGE.Ready;

    const strTime = bench(
      '4x STAGE_ORDER[str] (4 lookups)',
      () => {
        const wasReady =
          STAGE_ORDER_STR[currentStatusStr] >= STAGE_ORDER_STR['mounted'] &&
          STAGE_ORDER_STR[currentStatusStr] <= STAGE_ORDER_STR['ready'];
        void wasReady;
      },
      ITERATIONS,
    );

    const numTime = bench(
      '2x numeric compare',
      () => {
        const wasReady = currentStage >= STAGE.Mounted && currentStage <= STAGE.Ready;
        void wasReady;
      },
      ITERATIONS,
    );

    const speedup = strTime / numTime;
    console.log(`  Speedup: ${speedup.toFixed(2)}x`);
    expect(speedup).toBeGreaterThan(0.3);
  });
});

describe('typeof hooks check vs bitfield', () => {
  const HookBit = {
    Mount: 1 << 0,
    Update: 1 << 1,
    Unmount: 1 << 2,
  } as const;

  it('runStartup: typeof × 3 per call vs bitfield & × 3', () => {
    const instance = {
      onMount: () => Promise.resolve(),
      onUpdate: () => Promise.resolve(),
      onUnmount: () => Promise.resolve(),
    };

    const hookFlags =
      (typeof instance.onMount   === 'function' ? HookBit.Mount   : 0) |
      (typeof instance.onUpdate  === 'function' ? HookBit.Update  : 0) |
      (typeof instance.onUnmount === 'function' ? HookBit.Unmount : 0);

    const typeofTime = bench(
      'typeof × 3 checks per call',
      () => {
        const a = typeof instance.onMount === 'function';
        const b = typeof instance.onUpdate === 'function';
        const c = typeof instance.onUnmount === 'function';
        void a; void b; void c;
      },
      ITERATIONS,
    );

    const bitfieldTime = bench(
      'bitfield & × 3 checks per call',
      () => {
        const a = (hookFlags & HookBit.Mount) !== 0;
        const b = (hookFlags & HookBit.Update) !== 0;
        const c = (hookFlags & HookBit.Unmount) !== 0;
        void a; void b; void c;
      },
      ITERATIONS,
    );

    const speedup = typeofTime / bitfieldTime;
    console.log(`  Speedup: ${speedup.toFixed(2)}x`);
    expect(speedup).toBeGreaterThan(0.5);
  });

  it('runStartup: typeof × 3 for NO-hooks component vs bitfield (fast exit)', () => {
    const emptyInstance = {};

    const hookFlags = 0;

    const typeofTime = bench(
      'typeof × 3 on empty component (no hooks)',
      () => {
        const a = typeof (emptyInstance as { onMount?: unknown }).onMount === 'function';
        const b = typeof (emptyInstance as { onUpdate?: unknown }).onUpdate === 'function';
        const c = typeof (emptyInstance as { onUnmount?: unknown }).onUnmount === 'function';
        void a; void b; void c;
      },
      ITERATIONS,
    );

    const bitfieldTime = bench(
      'bitfield & 0 check (hookFlags=0 → skip all)',
      () => {
        if (hookFlags !== 0) {
          const a = (hookFlags & HookBit.Mount) !== 0;
          const b = (hookFlags & HookBit.Update) !== 0;
          const c = (hookFlags & HookBit.Unmount) !== 0;
          void a; void b; void c;
        }
      },
      ITERATIONS,
    );

    const speedup = typeofTime / bitfieldTime;
    console.log(`  Speedup (no-hooks fast-exit): ${speedup.toFixed(2)}x`);
    expect(speedup).toBeGreaterThan(1.0);
  });
});

describe('Full lifecycle loop simulation', () => {
  const STAGE_ORDER_STR: Record<string, number> = {
    registered: 0, resolved: 1, created: 2, mounted: 3,
    ready: 4, unmounting: 5, unmounted: 6, destroyed: 7, failed: 8,
  };

  const STAGE = {
    Registered: 0, Resolved: 1, Created: 2, Mounted: 3,
    Ready: 4, Unmounting: 5, Unmounted: 6, Destroyed: 7, Failed: 8,
  } as const;

  const N_NODES = 1000;
  const N_ITERS = 100;

  it('string status (N=1000, 100 reconcile passes)', () => {
    const statusArr: string[] = Array.from({ length: N_NODES }, () => 'ready');

    const t0 = performance.now();
    for (let iter = 0; iter < N_ITERS; iter++) {
      for (let i = 0; i < N_NODES; i++) {
        const canUpdate = statusArr[i] === 'ready';
        const canTransition = STAGE_ORDER_STR['unmounting'] > STAGE_ORDER_STR[statusArr[i]];
        void canUpdate; void canTransition;
      }
    }
    const strTime = (performance.now() - t0) * 1_000_000 / (N_NODES * N_ITERS);
    console.log(`  String status per-node: ${strTime.toFixed(3)} ns/op`);

    const numArr: number[] = Array.from({ length: N_NODES }, () => STAGE.Ready);

    const t1 = performance.now();
    for (let iter = 0; iter < N_ITERS; iter++) {
      for (let i = 0; i < N_NODES; i++) {
        const canUpdate = numArr[i] === STAGE.Ready;
        const canTransition = STAGE.Unmounting > numArr[i];
        void canUpdate; void canTransition;
      }
    }
    const numTime = (performance.now() - t1) * 1_000_000 / (N_NODES * N_ITERS);
    console.log(`  Numeric stage per-node: ${numTime.toFixed(3)} ns/op`);

    const speedup = strTime / numTime;
    console.log(`  Speedup: ${speedup.toFixed(2)}x`);
    expect(speedup).toBeGreaterThan(0.3);
  });
});

describe('Scaling: lifecycle grid N', () => {
  const STAGE_ORDER_STR: Record<string, number> = {
    registered: 0, resolved: 1, created: 2, mounted: 3,
    ready: 4, unmounting: 5, unmounted: 6, destroyed: 7, failed: 8,
  };

  it('avalanche: node count grows 0 → 5000, string pass is measured', () => {
    const steps = [0, 1, 8, 64, 512, 5000];
    for (const n of steps) {
      const statusArr: string[] = Array.from({ length: n }, () => 'ready');
      const t = benchAvgNs(
        () => {
          for (let i = 0; i < n; i++) {
            const canUpdate = statusArr[i] === 'ready';
            const canTransition = STAGE_ORDER_STR['unmounting'] > STAGE_ORDER_STR[statusArr[i]];
            void canUpdate; void canTransition;
          }
        },
        200,
        { warmupIterations: 20 },
      );
      console.log(`  N=${n}: ${t.toFixed(1)} ns/op (full scan warm)`);
      expect(t).toBeGreaterThan(0);
    }
  });

  it('cold vs warm: one full pass over N=2000', () => {
    const n = 2000;
    const statusArr: string[] = Array.from({ length: n }, () => 'ready');

    const work = (): void => {
      for (let i = 0; i < n; i++) {
        const canUpdate = statusArr[i] === 'ready';
        const canTransition = STAGE_ORDER_STR['unmounting'] > STAGE_ORDER_STR[statusArr[i]];
        void canUpdate; void canTransition;
      }
    };

    const { coldNsPerOp, warmNsPerOp } = coldVsWarm(work, 80);
    console.log(`  cold total ns (single pass): ${coldNsPerOp.toFixed(0)}`);
    console.log(`  warm avg ns/op (outer): ${warmNsPerOp.toFixed(2)}`);
    expect(coldNsPerOp).toBeGreaterThan(0);
  });

  it('boundary: currentStatusStr === registered (both comparisons are finite)', () => {
    const STAGE_ORDER_STR: Record<string, number> = {
      registered: 0, resolved: 1, created: 2, mounted: 3,
      ready: 4, unmounting: 5, unmounted: 6, destroyed: 7, failed: 8,
    };

    let currentStatusStr = 'registered';
    const t = benchAvgNs(
      () => {
        const canUpdate = currentStatusStr === 'ready';
        const canTransition =
          STAGE_ORDER_STR['unmounting'] > STAGE_ORDER_STR[currentStatusStr];
        void canUpdate;
        void canTransition;
      },
      400,
      { warmupIterations: 40 },
    );
    console.log(`  registered-edge warm: ${t.toFixed(2)} ns/op`);
    expect(t).toBeGreaterThan(0);
    expect(Number.isFinite(t)).toBe(true);
  });
});

describe('Benchmark: LifecycleEngine production API', () => {
  it('prints full startup/shutdown cycle without hooks', () => {
    console.log('\n=== LifecycleEngine no-hooks cycle ===');

    const ns = benchAvgNs(
      () => {
        const instance = new NoHooksLifecycleComponent();
        const engine = createInitializedEngine(instance);
        const startup = engine.runStartup(instance);
        if (startup instanceof Promise) {
          throw new Error('Expected synchronous no-hooks startup');
        }
        const shutdown = engine.runShutdown(instance);
        if (shutdown instanceof Promise) {
          throw new Error('Expected synchronous no-hooks shutdown');
        }
      },
      20_000,
      { warmupIterations: 1000 }
    );

    console.log(`  no-hooks startup/shutdown: ${ns.toFixed(2)} ns/op`);

    expect(ns).toBeGreaterThan(0);
    expect(Number.isFinite(ns)).toBe(true);
  });

  it('prints full startup/shutdown cycle with sync hooks', () => {
    console.log('\n=== LifecycleEngine sync hooks cycle ===');

    const ns = benchAvgNs(
      () => {
        const instance = new SyncHooksLifecycleComponent();
        const engine = createInitializedEngine(instance);
        const startup = engine.runStartup(instance);
        if (startup instanceof Promise) {
          throw new Error('Expected synchronous hooks startup');
        }
        const shutdown = engine.runShutdown(instance);
        if (shutdown instanceof Promise) {
          throw new Error('Expected synchronous hooks shutdown');
        }
      },
      20_000,
      { warmupIterations: 1000 }
    );

    console.log(`  sync hooks startup/shutdown: ${ns.toFixed(2)} ns/op`);

    expect(ns).toBeGreaterThan(0);
    expect(Number.isFinite(ns)).toBe(true);
  });

  it('compares sync hooks and async hooks through a real LifecycleEngine', async () => {
    console.log('\n=== LifecycleEngine sync vs async hooks ===');

    const syncNs = benchAvgNs(
      () => {
        const instance = new SyncHooksLifecycleComponent();
        const engine = createInitializedEngine(instance);
        const startup = engine.runStartup(instance);
        if (startup instanceof Promise) {
          throw new Error('Expected synchronous hooks startup');
        }
        const shutdown = engine.runShutdown(instance);
        if (shutdown instanceof Promise) {
          throw new Error('Expected synchronous hooks shutdown');
        }
      },
      10_000,
      { warmupIterations: 500 }
    );

    const asyncNs = await benchAvgAsyncNs(
      async () => {
        const instance = new AsyncHooksLifecycleComponent();
        const engine = createInitializedEngine(instance);
        const startup = engine.runStartup(instance);
        if (startup instanceof Promise) {
          await startup;
        }
        const shutdown = engine.runShutdown(instance);
        if (shutdown instanceof Promise) {
          await shutdown;
        }
      },
      2_000,
      { warmupIterations: 200 }
    );

    console.log(`  sync hooks: ${syncNs.toFixed(2)} ns/op`);
    console.log(`  async hooks: ${asyncNs.toFixed(2)} ns/op`);
    console.log(`  async/sync ratio: ${(asyncNs / syncNs).toFixed(2)}x`);

    expect(syncNs).toBeGreaterThan(0);
    expect(asyncNs).toBeGreaterThan(0);
    expect(Number.isFinite(syncNs)).toBe(true);
    expect(Number.isFinite(asyncNs)).toBe(true);
  });

  it('prints failed startup cleanup path on a real LifecycleEngine', () => {
    console.log('\n=== LifecycleEngine failed startup ===');

    const ns = benchAvgNs(
      () => {
        const instance = new FailedLifecycleComponent();
        const engine = createInitializedEngine(instance);
        const startup = engine.runStartup(instance);
        if (startup instanceof Promise) {
          throw new Error('Expected synchronous failure startup');
        }
        if (startup.ok) {
          throw new Error('Expected failed startup result');
        }
        if (!engine.isTerminated()) {
          throw new Error('Expected terminated engine after failed startup');
        }
      },
      5_000,
      { warmupIterations: 200 }
    );

    console.log(`  failed startup cleanup: ${ns.toFixed(2)} ns/op`);

    expect(ns).toBeGreaterThan(0);
    expect(Number.isFinite(ns)).toBe(true);
  });
});

jest.setTimeout(120_000);
