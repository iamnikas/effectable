/**
 * connect wide/deep resilience (L24, L25).
 *
 * @module Effectable/connect.resilience.test
 */

import { Component, GraphRuntime, connect, createStore, h } from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

jest.setTimeout(120_000);

const WIDE_N = 10_000;
const DEEP_CHAIN = 16;

interface BenchState {
  version: number;
}

type BenchAction = { type: 'BUMP' };

interface LeafProps {
  id: number;
  version?: number;
}

/**
 * @param {BenchState} state
 * @param {BenchAction} action
 * @returns {BenchState}
 */
function reducer (state: BenchState, action: BenchAction): BenchState {
  if (action.type === 'BUMP') {
    return { version: state.version + 1 };
  }
  return state;
}

describe('connect resilience (L24/L25)', () => {
  it('wide: 10k connected leaves depth≤3 receive one dispatch', async () => {
    const store = createStore<BenchState, BenchAction>(reducer, { version: 0 });
    let updateCount = 0;

    class WideLeaf extends Component<Record<string, never>, LeafProps> {
      public override onUpdate (): void {
        updateCount += 1;
      }
    }

    const ConnectedLeaf = connect<
      BenchState,
      LeafProps,
      Pick<LeafProps, 'version'>,
      BenchAction
    >(
      store,
      (state: BenchState) => ({ version: state.version }),
    )(WideLeaf);

    class WideHost extends Component<Record<string, never>, { version?: number }> {
      public override compose (): VirtualServiceNode[] {
        const nodes: VirtualServiceNode[] = [];
        for (let i = 0; i < WIDE_N; i += 1) {
          nodes.push(h(ConnectedLeaf, { id: i }));
        }
        return nodes;
      }
    }

    const ConnectedHost = connect<
      BenchState,
      { version?: number },
      { version: number },
      BenchAction
    >(
      store,
      (state: BenchState) => ({ version: state.version }),
    )(WideHost);

    const runtime = await GraphRuntime.mount(h(ConnectedHost, {}));
    await Promise.resolve();
    await Promise.resolve();
    updateCount = 0;

    store.dispatch({ type: 'BUMP' });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    // Host + 10k leaves (and possible kick-off) — expect mass leaf onUpdate calls.
    expect(updateCount).toBeGreaterThanOrEqual(WIDE_N);

    await runtime.unmount();
    store.destroy();
  });

  it('deep: connected chain depth≥16 mount/dispatch/unmount', async () => {
    const store = createStore<BenchState, BenchAction>(reducer, { version: 0 });
    let leafUpdates = 0;

    class DeepLeaf extends Component<Record<string, never>, { version?: number }> {
      public override onUpdate (): void {
        leafUpdates += 1;
      }
    }

    const ConnectedLeaf = connect<
      BenchState,
      { version?: number },
      { version: number },
      BenchAction
    >(
      store,
      (state: BenchState) => ({ version: state.version }),
    )(DeepLeaf);

    type ChainProps = { depth: number; version?: number };

    class DeepLink extends Component<Record<string, never>, ChainProps> {
      public override compose (): VirtualServiceNode[] {
        if (this.props.depth <= 1) {
          return [h(ConnectedLeaf, {})];
        }

        return [h(ConnectedLink, { depth: this.props.depth - 1 })];
      }
    }

    const ConnectedLink = connect<
      BenchState,
      ChainProps,
      Pick<ChainProps, 'version' | 'depth'>,
      BenchAction
    >(
      store,
      // Strict mode: pass depth through explicitly. Relying on constructor own-props
      // surviving until the first compose() is incorrect once connect syncs mapped
      // props in applyToScope (before compose).
      (state: BenchState, props: ChainProps) => ({
        version: state.version,
        depth: props.depth,
      }),
    )(DeepLink);

    const runtime = await GraphRuntime.mount(
      h(ConnectedLink, { depth: DEEP_CHAIN }),
    );

    store.dispatch({ type: 'BUMP' });
    await Promise.resolve();
    await Promise.resolve();

    expect(leafUpdates).toBeGreaterThanOrEqual(1);
    expect(runtime.isActive()).toBe(true);

    await runtime.unmount();
    store.destroy();
  });
});
