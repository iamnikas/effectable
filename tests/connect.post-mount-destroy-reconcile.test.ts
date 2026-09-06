/**
 * Post-mount store.destroy() must not fail-stop GraphRuntime on a later parent reconcile.
 *
 * After #85, updateFiber → buildChildScope → applyToScope → syncConnectPropsBeforeCompose
 * called store.getState(). destroy() completes select but left connect treating the store as
 * live; getState() then throws and fail-stops the entire tree.
 *
 * After #91, applyToScope skips live sync post-mount, but RUNTIME_PROPS_RECEIVER still
 * resolves the store and may call getState() — destroyed stores must be treated as unresolved.
 *
 * Distinct from #87 (mount-time destroyed store / complete-without-next).
 * Distinct from #104's pre-#85 path (RUNTIME_PROPS_RECEIVER only).
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';

type S = { n: number };
type A = { type: 'INC' };

describe('connect post-mount store.destroy + parent reconcile', () => {
  it('mapState host: destroy then parent setState must keep GraphRuntime active', async () => {
    const store = createStore<S, A>(
      (state = { n: 0 }, action) => (action.type === 'INC' ? { n: state.n + 1 } : state),
      { n: 0 },
    );

    class Child extends Component<object, { v: number; n?: number }> {
      public override compose () {
        return [];
      }
    }

    const ConnectedChild = connect(
      store,
      (s: S, p: { v: number }) => ({ n: s.n, v: p.v }),
    )(Child);

    class Parent extends Component<{ v: number }, object> {
      public constructor (props: object) {
        super(props);
        this.state = { v: 1 };
      }

      public override compose () {
        return [h(ConnectedChild, { v: this.state.v })];
      }
    }

    const rt = await GraphRuntime.mount(h(Parent, {}));
    expect(rt.isActive()).toBe(true);

    store.destroy();

    const parent = rt.getRootInstance() as Parent;
    parent.setState({ v: 2 });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(rt.isActive()).toBe(true);
    expect(rt.getState()).toBe('active');
    expect(parent.state.v).toBe(2);

    await rt.unmount();
  });

  it('mapState+mapDispatch host: same destroy+reconcile must not fail-stop', async () => {
    const store = createStore<S, A>(
      (state = { n: 0 }, action) => (action.type === 'INC' ? { n: state.n + 1 } : state),
      { n: 0 },
    );

    class Child extends Component<object, { v: number; n?: number; inc?: () => void }> {
      public override compose () {
        return [];
      }
    }

    const ConnectedChild = connect(
      store,
      (s: S, p: { v: number }) => ({ n: s.n, v: p.v }),
      { inc: (): A => ({ type: 'INC' }) },
    )(Child);

    class Parent extends Component<{ v: number }, object> {
      public constructor (props: object) {
        super(props);
        this.state = { v: 1 };
      }

      public override compose () {
        return [h(ConnectedChild, { v: this.state.v })];
      }
    }

    const rt = await GraphRuntime.mount(h(Parent, {}));
    store.destroy();
    (rt.getRootInstance() as Parent).setState({ v: 3 });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });

    expect(rt.isActive()).toBe(true);
    expect(rt.getState()).toBe('active');

    await rt.unmount();
  });
});
