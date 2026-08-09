/**
 * Wide shallow bootstrap bench (A16).
 * Run: npx jest bootstrap.wide.benchmark --testTimeout=120000
 */

/* eslint-disable no-console */

import { Component, bootstrap, h } from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

jest.setTimeout(120_000);

const WIDE_N = 10_000;

interface WideLeafProps {
  id: number;
}

interface WideRootProps {
  tag: string;
}

class WideLeaf extends Component<Record<string, never>, WideLeafProps> {
  public override onMount (): void {}

  public override onUnmount (): void {}
}

class WideRoot extends Component<Record<string, never>, WideRootProps> {
  public override compose (): VirtualServiceNode[] {
    const nodes: VirtualServiceNode[] = [];
    for (let i = 0; i < WIDE_N; i += 1) {
      nodes.push(h(WideLeaf, { id: i }, String(i)));
    }
    return nodes;
  }
}

describe('Benchmark: bootstrap wide shallow 10k (A16)', () => {
  it('prints bootstrap+shutdown for 10k leaves depth≤3', async () => {
    console.log('\n=== bootstrap wide 10k ===');

    const t0 = process.hrtime.bigint();
    const handle = await bootstrap<WideRootProps, WideRoot>(
      WideRoot,
      { tag: 'wide' },
      { name: 'bench-wide-10k' },
    );
    const t1 = process.hrtime.bigint();
    expect(handle.isRunning()).toBe(true);

    await handle.shutdown();
    const t2 = process.hrtime.bigint();

    const bootNs = Number(t1 - t0);
    const shutdownNs = Number(t2 - t1);

    console.log(`  bootstrap 10k: ${(bootNs / 1e6).toFixed(3)} ms wall`);
    console.log(`  shutdown 10k: ${(shutdownNs / 1e6).toFixed(3)} ms wall`);

    expect(bootNs).toBeGreaterThan(0);
    expect(shutdownNs).toBeGreaterThan(0);
    expect(Number.isFinite(bootNs)).toBe(true);
    expect(Number.isFinite(shutdownNs)).toBe(true);
  });
});
