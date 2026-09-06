/**
 * Regression: connect on a destroyed store must fail mount.
 *
 * mapState: createStore.select() after destroy() completes with zero next emissions
 * (and syncConnectPropsBeforeCompose calls getState()). Connect used to treat that
 * as a successful onMount — a zombie ACTIVE tree.
 *
 * mapDispatch-only: there is no select subscription, so the same destroy() left
 * GraphRuntime ACTIVE with dispatch props that throw on call. Must reject via getState().
 *
 * @module Effectable/connect/destroyed-store-mount.test
 */

import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

interface State {
  n: number;
}

type TestAction = { type: string };

describe('connect: destroyed store mount', () => {
  it('rejects GraphRuntime.mount when mapState select completes without a first next', async () => {
    const store = createStore<State, TestAction>(
      (state) => state,
      { n: 1 },
    );
    store.destroy();

    let userOnMountCalls = 0;

    class Gate extends Component<{ n?: number; adminToken?: string }, { adminToken?: string }> {
      public constructor (props: { adminToken?: string }) {
        super(props);
      }

      public override onMount (): void {
        userOnMountCalls += 1;
      }

      public override compose (): VirtualServiceNode | null {
        return null;
      }
    }

    const Connected = connect(
      store,
      (s: State) => ({ n: s.n }),
    )(Gate);

    await expect(
      GraphRuntime.mount(h(Connected, { adminToken: 'SECRET' })),
    ).rejects.toThrow(/completed before the first state emission|destroyed/i);

    expect(userOnMountCalls).toBe(0);
  });

  it('rejects GraphRuntime.mount for mapDispatch-only on a destroyed store', async () => {
    const store = createStore<State, TestAction>(
      (state) => state,
      { n: 1 },
    );
    store.destroy();

    let userOnMountCalls = 0;

    class Gate extends Component<{ ping?: () => void }, Record<string, never>> {
      public constructor (props: Record<string, never>) {
        super(props);
      }

      public override onMount (): void {
        userOnMountCalls += 1;
      }

      public override compose (): VirtualServiceNode | null {
        return null;
      }
    }

    const Connected = connect(
      store,
      null,
      (dispatch) => ({
        ping: (): void => {
          dispatch({ type: 'PING' });
        },
      }),
    )(Gate);

    await expect(
      GraphRuntime.mount(h(Connected, {})),
    ).rejects.toThrow(/destroyed/i);

    expect(userOnMountCalls).toBe(0);
  });

  it('still mounts when the store is alive', async () => {
    const store = createStore<State, TestAction>(
      (state) => state,
      { n: 7 },
    );

    let userOnMountCalls = 0;

    class Box extends Component<{ n?: number }, Record<string, never>> {
      public constructor (props: Record<string, never>) {
        super(props);
      }

      public override onMount (): void {
        userOnMountCalls += 1;
      }
    }

    const Connected = connect(
      store,
      (s: State) => ({ n: s.n }),
    )(Box);

    const rt = await GraphRuntime.mount(h(Connected, {}));
    expect(rt.isActive()).toBe(true);
    expect(userOnMountCalls).toBe(1);
    expect((rt.getRootInstance() as Box).props.n).toBe(7);
    await rt.unmount();
    store.destroy();
  });
});
