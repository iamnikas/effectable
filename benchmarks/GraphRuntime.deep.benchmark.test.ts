/**
 * Production-scale deep GraphRuntime benches (I46).
 * Run: npx jest GraphRuntime.deep.benchmark --testTimeout=120000
 */

/* eslint-disable no-console */

import { Component, GraphRuntime, h } from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

jest.setTimeout(120_000);

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

interface DeepProps {
  depth: number;
  value: number;
}

class DeepNode extends Component<Record<string, never>, DeepProps> {
  public override compose (): VirtualServiceNode[] | null {
    if (this.props.depth <= 0) {
      return null;
    }

    return [h(DeepNode, { depth: this.props.depth - 1, value: this.props.value })];
  }
}

describe('Benchmark: GraphRuntime deep chain (I46)', () => {
  it('prints mount/reconcile/unmount cost curve for depth 32 and 64', async () => {
    console.log('\n=== GraphRuntime deep cost curve ===');

    for (const depth of [32, 64]) {
      const mountNs = await benchAvgAsyncNs(
        async () => {
          const runtime = await GraphRuntime.mount(
            h(DeepNode, { depth, value: 0 }),
          );
          await runtime.unmount();
        },
        4,
        { warmupIterations: 1 },
      );

      const runtime = await GraphRuntime.mount(h(DeepNode, { depth, value: 0 }));
      const reconcileNs = await benchAvgAsyncNs(
        async () => {
          await runtime.reconcile(h(DeepNode, { depth, value: Math.random() }));
        },
        20,
        { warmupIterations: 2 },
      );
      await runtime.unmount();

      console.log(`  depth=${String(depth)} mount+unmount: ${mountNs.toFixed(2)} ns/op`);
      console.log(`  depth=${String(depth)} reconcile: ${reconcileNs.toFixed(2)} ns/op`);

      expect(mountNs).toBeGreaterThan(0);
      expect(reconcileNs).toBeGreaterThan(0);
      expect(Number.isFinite(mountNs)).toBe(true);
      expect(Number.isFinite(reconcileNs)).toBe(true);
    }
  });
});
