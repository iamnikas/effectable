/**
 * Wide connected tree dispatch+reconcile (L27).
 * Run: npx jest connect.wide.benchmark --testTimeout=120000
 */

/* eslint-disable no-console */

import { Component, GraphRuntime, connect, createStore, h } from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

jest.setTimeout(120_000);

const WIDE_N = 10_000;

interface BenchState {
  version: number;
}

type BenchAction = { type: 'BUMP'; payload?: undefined };

interface LeafProps {
  id: number;
  version?: number;
}

/**
 * @param {BenchState} state
 * @param {BenchAction} _action
 * @returns {BenchState}
 */
function reducer (state: BenchState, _action: BenchAction): BenchState {
  if (_action.type === 'BUMP') {
    return { version: state.version + 1 };
  }
  return state;
}

class WideLeaf extends Component<Record<string, never>, LeafProps> {
  public override onUpdate (): void {}
}

class WideHost extends Component<Record<string, never>, { version?: number }> {
  public override compose (): VirtualServiceNode[] {
    const nodes: VirtualServiceNode[] = [];
    for (let i = 0; i < WIDE_N; i += 1) {
      nodes.push(h(ConnectedLeaf, { id: i }));
    }
    return nodes;
  }
}

const store = createStore<BenchState, BenchAction>(reducer, { version: 0 });

const ConnectedLeaf = connect<BenchState, LeafProps, Pick<LeafProps, 'version'>, BenchAction>(
  store,
  (state: BenchState) => ({ version: state.version }),
)(WideLeaf);

const ConnectedHost = connect<BenchState, { version?: number }, { version: number }, BenchAction>(
  store,
  (state: BenchState) => ({ version: state.version }),
)(WideHost);

describe('Benchmark: connect wide 10k (L27)', () => {
  it('prints mount and dispatch+reconcile for 10k connected leaves', async () => {
    console.log('\n=== connect wide 10k ===');

    const t0 = process.hrtime.bigint();
    const runtime = await GraphRuntime.mount(h(ConnectedHost, {}));
    const t1 = process.hrtime.bigint();

    store.dispatch({ type: 'BUMP' });
    await Promise.resolve();
    await Promise.resolve();
    const t2 = process.hrtime.bigint();

    await runtime.unmount();
    const t3 = process.hrtime.bigint();

    const mountNs = Number(t1 - t0);
    const dispatchNs = Number(t2 - t1);
    const unmountNs = Number(t3 - t2);

    console.log(`  mount 10k connected: ${(mountNs / 1e6).toFixed(3)} ms`);
    console.log(`  dispatch+flush: ${(dispatchNs / 1e6).toFixed(3)} ms`);
    console.log(`  unmount: ${(unmountNs / 1e6).toFixed(3)} ms`);

    expect(mountNs).toBeGreaterThan(0);
    expect(dispatchNs).toBeGreaterThan(0);
    expect(unmountNs).toBeGreaterThan(0);
    expect(Number.isFinite(mountNs)).toBe(true);
    expect(Number.isFinite(dispatchNs)).toBe(true);
    expect(Number.isFinite(unmountNs)).toBe(true);

    store.destroy();
  });
});
