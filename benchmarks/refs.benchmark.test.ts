/**
 * UseRef getter benchmark.
 * Run: npx jest refs.benchmark --testTimeout=60000
 */

/* eslint-disable no-console */

import { benchAvgNs, coldVsWarm } from './helpers/effectableBenchmarkHelpers';
import { Component, GraphRuntime, UseRef, h } from 'Effectable';
import type { RefObject, VirtualServiceNode } from 'Effectable';

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

interface RefLeafProps {
  id: string;
}

interface RefHostProps {
  count: number;
}

class RefLeafComponent extends Component<Record<string, never>, RefLeafProps> {
  constructor (props: RefLeafProps) {
    super(props);
    this.state = {};
  }

  public override onMount (): void {}

  public override onUnmount (): void {}
}

class DecoratedRefHost extends Component<Record<string, never>, RefHostProps> {
  @UseRef()
  public declare childRef: RefObject<RefLeafComponent>;

  constructor (props: RefHostProps) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode[] {
    return [
      h(RefLeafComponent, { id: 'decorated-child' }, this.childRef),
    ];
  }
}

class MultiRefHost extends Component<Record<string, never>, RefHostProps> {
  private readonly refs: Array<RefObject<RefLeafComponent>>;

  constructor (props: RefHostProps) {
    super(props);
    this.state = {};
    this.refs = [];

    for (let i = 0; i < props.count; i += 1) {
      this.refs.push({ current: null });
    }
  }

  public override compose (): VirtualServiceNode[] {
    const nodes: VirtualServiceNode[] = [];

    for (let i = 0; i < this.props.count; i += 1) {
      const ref = this.refs[i];
      nodes.push(h(RefLeafComponent, { id: `multi-${String(i)}` }, ref, `multi-${String(i)}`));
    }

    return nodes;
  }
}

function benchPerf (label: string, fn: () => void, n: number): number {
  const start = performance.now();
  for (let i = 0; i < n; i++) fn();
  const elapsed = (performance.now() - start) * 1_000_000;
  const nsPerOp = elapsed / n;
  console.log(`  ${label}: ${nsPerOp.toFixed(2)} ns/op`);
  return nsPerOp;
}

describe('UseRef getter: string concat vs pre-computed key', () => {
  it('getter: string concat per call vs pre-computed refKey closure', () => {
    const propertyKey = 'childRef';

    const originalGetter = function (this: Record<string, unknown>) {
      const key = `__ref_${String(propertyKey)}`;
      if (this[key] === undefined) {
        this[key] = { current: null };
      }
      return this[key];
    };

    const refKey = `__ref_${String(propertyKey)}`;
    const optimizedGetter = function (this: Record<string, unknown>) {
      if (this[refKey] === undefined) {
        this[refKey] = { current: null };
      }
      return this[refKey];
    };

    const instance1: Record<string, unknown> = {};
    const instance2: Record<string, unknown> = {};

    originalGetter.call(instance1);
    optimizedGetter.call(instance2);

    const originalTime = benchPerf(
      'Original getter: string concat per call',
      () => {
        originalGetter.call(instance1);
      },
      ITERATIONS,
    );

    const optimizedTime = benchPerf(
      'Optimized getter: pre-computed refKey from closure',
      () => {
        optimizedGetter.call(instance2);
      },
      ITERATIONS,
    );

    const speedup = originalTime / optimizedTime;
    console.log(`  Speedup (pre-computed refKey): ${speedup.toFixed(2)}x`);
    expect(speedup).toBeGreaterThan(1.0);
  });

  it('warmup: cold vs warm for the optimized getter', () => {
    const refKey = `__ref_${String('warmRef')}`;
    const getter = function (this: Record<string, unknown>) {
      if (this[refKey] === undefined) {
        this[refKey] = { current: null };
      }
      return this[refKey];
    };
    const inst: Record<string, unknown> = {};

    const { coldNsPerOp, warmNsPerOp } = coldVsWarm(
      () => {
        getter.call(inst);
      },
      40_000,
    );
    console.log(`  cold first-call ns: ${coldNsPerOp.toFixed(0)}`);
    console.log(`  warm avg ns/op: ${warmNsPerOp.toFixed(2)}`);
    expect(warmNsPerOp).toBeGreaterThan(0);
    expect(coldNsPerOp).toBeGreaterThan(0);
  });

  it('small / medium / large repeated get volume: stable ns/op', () => {
    const refKey = `__ref_${String('scale')}`;
    const getter = function (this: Record<string, unknown>) {
      if (this[refKey] === undefined) {
        this[refKey] = { current: null };
      }
      return this[refKey];
    };

    for (const count of [100, 10_000, 200_000]) {
      const inst: Record<string, unknown> = {};
      const t = benchAvgNs(
        () => {
          for (let i = 0; i < count; i++) {
            getter.call(inst);
          }
        },
        10,
        { warmupIterations: 3 },
      );
      console.log(`  inner gets=${count}: ${t.toFixed(0)} ns/op (warm total/10 outer)`);
      expect(t).toBeGreaterThan(0);
    }
  });

  it('long propertyKey: precomputed refKey — finite ns/op', () => {
    const longKey = `childRef_${'x'.repeat(80)}`;
    const refKey = `__ref_${String(longKey)}`;
    const getter = function (this: Record<string, unknown>) {
      if (this[refKey] === undefined) {
        this[refKey] = { current: null };
      }
      return this[refKey];
    };
    const inst: Record<string, unknown> = {};
    const t = benchAvgNs(
      () => {
        getter.call(inst);
      },
      2000,
      { warmupIterations: 100 },
    );
    console.log(`  long key warm avg: ${t.toFixed(2)} ns/op`);
    expect(t).toBeGreaterThan(0);
    expect(Number.isFinite(t)).toBe(true);
  });
});

describe('Benchmark: refs production runtime path', () => {
  it('prints mount/unmount with @UseRef and real bind/unbind of ref.current', async () => {
    console.log('\n=== refs GraphRuntime bind/unbind ===');

    const ns = await benchAvgAsyncNs(
      async () => {
        const runtime = await GraphRuntime.mount(
          h(DecoratedRefHost, { count: 1 })
        );

        const root = runtime.getRootInstance();
        if (!(root instanceof DecoratedRefHost)) {
          throw new Error('Expected DecoratedRefHost as runtime root');
        }

        if (root.childRef.current === null) {
          throw new Error('Expected ref.current to be assigned after mount');
        }

        await runtime.unmount();

        if (root.childRef.current !== null) {
          throw new Error('Expected ref.current to be cleared after unmount');
        }
      },
      300,
      { warmupIterations: 30 }
    );

    console.log(`  decorated ref bind/unbind: ${ns.toFixed(2)} ns/op`);

    expect(ns).toBeGreaterThan(0);
    expect(Number.isFinite(ns)).toBe(true);
  });

  it('prints scaling across many refs in one GraphRuntime tree', async () => {
    console.log('\n=== refs multi-bind scaling ===');

    for (const count of [1, 16, 64]) {
      const ns = await benchAvgAsyncNs(
        async () => {
          const runtime = await GraphRuntime.mount(
            h(MultiRefHost, { count })
          );
          await runtime.unmount();
        },
        120,
        { warmupIterations: 20 }
      );

      console.log(`  refs count=${String(count)}: ${ns.toFixed(2)} ns/op`);
      expect(ns).toBeGreaterThan(0);
      expect(Number.isFinite(ns)).toBe(true);
    }
  });
});

jest.setTimeout(120_000);
