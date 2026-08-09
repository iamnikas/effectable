/**
 * L24b: short soak — repeated dispatch+reconcile without growing subscription count.
 *
 * @module Effectable/connect.soak.test
 */

import { Component, GraphRuntime, connect, createStore, h } from 'Effectable';
import type { Selector, Store, VirtualServiceNode } from 'Effectable';
import { Observable } from 'rxjs';

jest.setTimeout(120_000);

const SOAK_ITERS = 200;
const LEAF_COUNT = 50;

interface SoakState {
  tick: number;
}

type SoakAction = { type: 'TICK' };

interface LeafProps {
  id: number;
  tick?: number;
}

/**
 * @param {SoakState} state
 * @param {SoakAction} action
 * @returns {SoakState}
 */
function reducer (state: SoakState, action: SoakAction): SoakState {
  if (action.type === 'TICK') {
    return { tick: state.tick + 1 };
  }
  return state;
}

/**
 * Wraps store, counting select calls (proxy without as).
 *
 * @param {Store<SoakState, SoakAction>} base
 * @param {{ count: number }} counter
 * @returns {Store<SoakState, SoakAction>}
 */
function wrapStoreCountingSelect (
  base: Store<SoakState, SoakAction>,
  counter: { count: number },
): Store<SoakState, SoakAction> {
  return {
    dispatch: base.dispatch,
    getState: base.getState,
    state$: base.state$,
    destroy: base.destroy,
    select: <T>(selectorFn: Selector<SoakState, T>): Observable<T> => {
      counter.count += 1;
      return base.select(selectorFn);
    },
  };
}

async function drain (): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('connect soak (L24b)', () => {
  it('repeated dispatches do not increase active store subscription count', async () => {
    const baseStore = createStore<SoakState, SoakAction>(reducer, { tick: 0 });
    const selectCounter = { count: 0 };
    const store = wrapStoreCountingSelect(baseStore, selectCounter);

    class SoakLeaf extends Component<Record<string, never>, LeafProps> {
      public override onUpdate (): void {}
    }

    const ConnectedLeaf = connect<
      SoakState,
      LeafProps,
      Pick<LeafProps, 'tick'>,
      SoakAction
    >(
      store,
      (state: SoakState) => ({ tick: state.tick }),
    )(SoakLeaf);

    class SoakHost extends Component<Record<string, never>, { tick?: number }> {
      public override compose (): VirtualServiceNode[] {
        const nodes: VirtualServiceNode[] = [];
        for (let i = 0; i < LEAF_COUNT; i += 1) {
          nodes.push(h(ConnectedLeaf, { id: i }));
        }
        return nodes;
      }
    }

    const ConnectedHost = connect<
      SoakState,
      { tick?: number },
      { tick: number },
      SoakAction
    >(
      store,
      (state: SoakState) => ({ tick: state.tick }),
    )(SoakHost);

    const runtime = await GraphRuntime.mount(h(ConnectedHost, {}));
    await drain();

    const selectsAfterMount = selectCounter.count;

    for (let i = 0; i < SOAK_ITERS; i += 1) {
      store.dispatch({ type: 'TICK' });
      await drain();
    }

    expect(selectCounter.count).toBe(selectsAfterMount);
    expect(store.getState().tick).toBe(SOAK_ITERS);
    expect(runtime.isActive()).toBe(true);

    await runtime.unmount();
    store.destroy();
  });
});
