/**
 * RUNTIME_PROPS_RECEIVER gates mapDispatch refresh on shallowEqualOwnProps.
 * `===` treats NaN as always changed (NaN !== NaN), so a stable NaN own-prop
 * re-fires side-effecting mapDispatch on every parent dirty → fail-stop.
 * Distinct from #91 (applyToScope) and #107 (nested loop with === values).
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';
import type { DispatchMethod } from 'Effectable';

describe('connect NaN own-props mapDispatch loop', () => {
  type S = { n: number };
  type A = { type: 'TICK' };

  function makeReducer () {
    return (state: S | undefined, action: A): S => {
      const current = state ?? { n: 0 };
      if (action.type === 'TICK') {
        return { n: current.n + 1 };
      }
      return current;
    };
  }

  it('stable NaN own-prop must not re-fire mapDispatch on parent store updates', async () => {
    let mapDispatchCalls = 0;
    const store = createStore(makeReducer(), { n: 0 });

    class Child extends Component<object, { n?: number; scale?: number; noop?: () => void }> {
      public override compose () {
        return [];
      }
    }

    const ConnectedChild = connect(
      store,
      (s: S) => ({ n: s.n }),
      (dispatch: DispatchMethod<A>) => {
        mapDispatchCalls += 1;
        dispatch({ type: 'TICK' });
        return { noop: () => undefined };
      },
    )(Child);

    class Parent extends Component<object, { n?: number }> {
      public override compose () {
        return [h(ConnectedChild, { scale: Number.NaN })];
      }
    }

    const ConnectedParent = connect(store, (s: S) => ({ n: s.n }))(Parent);

    const runtime = await GraphRuntime.mount(h(ConnectedParent, {}));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });

    expect(runtime.getState()).toBe('active');
    expect(mapDispatchCalls).toBeLessThan(15);

    await runtime.unmount();
    store.destroy();
  }, 10000);

  it('finite own-prop change still rebinds mapDispatch', async () => {
    let lastScale: number | undefined;
    const store = createStore(makeReducer(), { n: 0 });

    type ChildOwn = { scale?: number };
    type ChildProps = {
      n?: number;
      scale?: number;
      readScale?: () => number | undefined;
    };

    class Child extends Component<object, ChildProps> {
      public override compose () {
        return [];
      }
    }

    function mapDispatchWithScale (
      _dispatch: DispatchMethod<A>,
      props: ChildOwn
    ): Pick<ChildProps, 'readScale'> {
      lastScale = props.scale;
      return { readScale: () => lastScale };
    }

    const ConnectedChild = connect(
      store,
      (s: S) => ({ n: s.n }),
      mapDispatchWithScale,
    )(Child);

    class Parent extends Component<object, { n?: number; scale: number }> {
      public override compose () {
        return [h(ConnectedChild, { scale: this.props.scale })];
      }
    }

    const runtime = await GraphRuntime.mount(h(Parent, { scale: 1 }));
    expect(lastScale).toBe(1);

    await runtime.reconcile(h(Parent, { scale: 2 }));
    expect(lastScale).toBe(2);

    await runtime.unmount();
    store.destroy();
  });
});
