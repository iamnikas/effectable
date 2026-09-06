/**
 * Nested connected trees: mapDispatch factory side-effect must not fail-stop GraphRuntime.
 *
 * Two re-entry paths after a connected parent dirties from a child factory dispatch:
 * 1) child `applyToScope` during UPDATE (dirty parent reconcile) — gated pre-mount only
 * 2) child `RUNTIME_PROPS_RECEIVER` — refreshDispatchProps only when own-props shallow-change
 *
 * Solo connected with the same factory is covered by the applyToScope gate (#91 class).
 * Nested parent+child additionally requires the props-receiver gate (#91 alone is insufficient).
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';

describe('connect nested mapDispatch factory side-effect', () => {
  type S = { n: number };
  type A = { type: 'TICK' } | { type: 'BUMP' };

  function makeReducer () {
    return (state: S | undefined, action: A): S => {
      const current = state ?? { n: 0 };
      if (action.type === 'TICK') {
        return { n: current.n + 1 };
      }
      if (action.type === 'BUMP') {
        return { n: current.n + 10 };
      }
      return current;
    };
  }

  it('solo connected: side-effecting mapDispatch does not fail-stop', async () => {
    let mapDispatchCalls = 0;
    const store = createStore(makeReducer(), { n: 0 });

    class Host extends Component<object, { n?: number; ping?: () => void }> {
      public override compose () {
        return [];
      }
    }

    const Connected = connect(
      store,
      (s: S) => ({ n: s.n }),
      (dispatch: (a: A) => A) => {
        mapDispatchCalls += 1;
        dispatch({ type: 'TICK' });
        return { ping: () => dispatch({ type: 'TICK' }) };
      },
    )(Host);

    const runtime = await GraphRuntime.mount(h(Connected, {}));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 80);
    });

    expect(runtime.getState()).toBe('active');
    expect(mapDispatchCalls).toBeLessThan(10);
    await runtime.unmount();
  });

  it('parent+child connected: child mapDispatch side-effect does not fail-stop', async () => {
    let mapDispatchCalls = 0;
    const store = createStore(makeReducer(), { n: 0 });

    class Child extends Component<object, { n?: number; ping?: () => void }> {
      public override compose () {
        return [];
      }
    }

    const ConnectedChild = connect(
      store,
      (s: S) => ({ n: s.n }),
      (dispatch: (a: A) => A) => {
        mapDispatchCalls += 1;
        dispatch({ type: 'TICK' });
        return { ping: () => dispatch({ type: 'TICK' }) };
      },
    )(Child);

    class Parent extends Component<object, { n?: number }> {
      public override compose () {
        return [h(ConnectedChild, {})];
      }
    }

    const ConnectedParent = connect(store, (s: S) => ({ n: s.n }))(Parent);

    const runtime = await GraphRuntime.mount(h(ConnectedParent, {}));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });

    expect(runtime.getState()).toBe('active');
    expect(runtime.isActive()).toBe(true);
    // applyToScope (pre-mount) + onMount + at most a props-receiver when own-props change —
    // not dozens of dirty re-entries.
    expect(mapDispatchCalls).toBeLessThan(10);

    store.dispatch({ type: 'BUMP' });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });

    expect(runtime.getState()).toBe('active');
    expect(mapDispatchCalls).toBeLessThan(10);

    await runtime.unmount();
  });

  it('RUNTIME_PROPS_RECEIVER still rebinds mapDispatch when own-props change', async () => {
    let lastSeenId: number | undefined;
    const store = createStore(makeReducer(), { n: 0 });

    class Child extends Component<
      object,
      { n?: number; id?: number; readId?: () => number | undefined; ping?: () => void }
    > {
      public override compose () {
        return [];
      }
    }

    const ConnectedChild = connect(
      store,
      (s: S) => ({ n: s.n }),
      (dispatch: (a: A) => A, props: { id?: number }) => {
        lastSeenId = props.id;
        return {
          readId: () => lastSeenId,
          ping: () => dispatch({ type: 'TICK' }),
        };
      },
    )(Child);

    class Parent extends Component<{ id: number }, { n?: number }> {
      public state: { id: number } = { id: 1 };

      public override compose () {
        return [h(ConnectedChild, { id: this.state.id })];
      }
    }

    const ConnectedParent = connect(store, (s: S) => ({ n: s.n }))(Parent);
    const runtime = await GraphRuntime.mount(h(ConnectedParent, {}));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(lastSeenId).toBe(1);
    const parent = runtime.getRootInstance() as Parent;
    parent.setState({ id: 2 });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(lastSeenId).toBe(2);
    expect(runtime.getState()).toBe('active');
    await runtime.unmount();
  });
});
