/**
 * Production-scale wide shallow GraphRuntime benches (I45).
 * Run: npx jest GraphRuntime.wide.benchmark --testTimeout=120000
 */

/* eslint-disable no-console */

import { Component, GraphRuntime, h } from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

jest.setTimeout(120_000);

const WIDE_N = 10_000;

async function benchAvgAsyncNs (
  fn: () => Promise<void>,
  iterations: number,
  options?: { warmupIterations?: number },
): Promise<number> {
  const warmup = options?.warmupIterations ?? Math.min(2, Math.max(0, Math.floor(iterations / 2)));

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

interface WideLeafProps {
  id: number;
  value: number;
}

interface WideHostProps {
  items: WideLeafProps[];
}

class WideLeaf extends Component<Record<string, never>, WideLeafProps> {
  public override onMount (): void {}

  public override onUnmount (): void {}
}

class WideHost extends Component<Record<string, never>, WideHostProps> {
  public override compose (): VirtualServiceNode[] {
    return this.props.items.map((item) => h(WideLeaf, item, String(item.id)));
  }
}

/**
 * Builds a leaf-props array for the wide host.
 *
 * @param {number} count - number of siblings
 * @param {number} valueOffset - value offset
 * @returns {WideLeafProps[]} items
 */
function createWideItems (count: number, valueOffset: number): WideLeafProps[] {
  const items: WideLeafProps[] = [];
  for (let i = 0; i < count; i += 1) {
    items.push({ id: i, value: i + valueOffset });
  }
  return items;
}

describe('Benchmark: GraphRuntime wide shallow 10k (I45)', () => {
  it('prints mount/unmount for 10k siblings depth≤3', async () => {
    console.log('\n=== GraphRuntime wide mount/unmount N=10000 ===');

    const items = createWideItems(WIDE_N, 0);
    const ns = await benchAvgAsyncNs(
      async () => {
        const runtime = await GraphRuntime.mount(h(WideHost, { items }));
        await runtime.unmount();
      },
      2,
      { warmupIterations: 1 },
    );

    console.log(`  mount+unmount 10k: ${ns.toFixed(2)} ns/op`);
    expect(ns).toBeGreaterThan(0);
    expect(Number.isFinite(ns)).toBe(true);
  });

  it('prints stable reconcile and keyed reorder at 10k', async () => {
    console.log('\n=== GraphRuntime wide reconcile 10k ===');

    let items = createWideItems(WIDE_N, 0);
    const runtime = await GraphRuntime.mount(h(WideHost, { items }));

    const stableNs = await benchAvgAsyncNs(
      async () => {
        items = createWideItems(WIDE_N, items[0] !== undefined ? items[0].value + 1 : 1);
        await runtime.reconcile(h(WideHost, { items }));
      },
      3,
      { warmupIterations: 1 },
    );

    const reorderNs = await benchAvgAsyncNs(
      async () => {
        const next = items.slice().reverse();
        items = next;
        await runtime.reconcile(h(WideHost, { items }));
      },
      2,
      { warmupIterations: 0 },
    );

    console.log(`  stable reconcile 10k: ${stableNs.toFixed(2)} ns/op`);
    console.log(`  keyed reverse 10k: ${reorderNs.toFixed(2)} ns/op`);

    expect(stableNs).toBeGreaterThan(0);
    expect(reorderNs).toBeGreaterThan(0);
    expect(Number.isFinite(stableNs)).toBe(true);
    expect(Number.isFinite(reorderNs)).toBe(true);

    await runtime.unmount();
  });
});
