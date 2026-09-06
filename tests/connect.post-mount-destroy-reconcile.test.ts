/**
 * Post-mount store.destroy() must not fail-stop GraphRuntime on a later parent reconcile.
 *
 * connect's RUNTIME_PROPS_RECEIVER re-runs mapState via store.getState(). After destroy(),
 * getState throws; without handling select completion that throw tear-down-fail-stops the tree.
 */
import { Component, GraphRuntime, connect, createStore, h, EMPTY_CONTEXT_SCOPE } from 'Effectable';

type S = { n: number };
type A = { type: 'INC' };

class Child extends Component<{ v: number; n?: number }, Record<string, never>> {
  public compose (): null {
    return null;
  }
}

class Parent extends Component<
  { Child: typeof Child },
  { v: number }
> {
  public state = { v: 1 };

  public compose () {
    return [h(this.props.Child, { v: this.state.v })];
  }
}

describe('connect post-mount store.destroy + parent reconcile', () => {
  test('mapState host: destroy then parent setState must keep GraphRuntime active', async () => {
    const store = createStore<S, A>(
      (state = { n: 0 }, action) => (action.type === 'INC' ? { n: state.n + 1 } : state),
      { n: 0 },
    );

    const ConnectedChild = connect(store, (s: S, p: { v: number }) => ({
      n: s.n,
      v: p.v,
    }))(Child);

    class P extends Parent {
      public constructor () {
        super({ Child: ConnectedChild as typeof Child });
      }
    }

    const rt = await GraphRuntime.mount(h(P, {}), EMPTY_CONTEXT_SCOPE);
    expect(rt.isActive()).toBe(true);

    store.destroy();

    const parent = rt.getRootInstance() as Parent;
    parent.setState({ v: 2 });
    await new Promise((r) => setTimeout(r, 20));

    expect(rt.isActive()).toBe(true);
    expect(rt.getState()).toBe('active');

    await rt.unmount();
  });

  test('mapState+mapDispatch host: same destroy+reconcile must not fail-stop', async () => {
    const store = createStore<S, A>(
      (state = { n: 0 }, action) => (action.type === 'INC' ? { n: state.n + 1 } : state),
      { n: 0 },
    );

    const ConnectedChild = connect(
      store,
      (s: S, p: { v: number }) => ({ n: s.n, v: p.v }),
      { inc: (): A => ({ type: 'INC' }) },
    )(Child);

    class P extends Parent {
      public constructor () {
        super({ Child: ConnectedChild as typeof Child });
      }
    }

    const rt = await GraphRuntime.mount(h(P, {}), EMPTY_CONTEXT_SCOPE);
    store.destroy();
    (rt.getRootInstance() as Parent).setState({ v: 3 });
    await new Promise((r) => setTimeout(r, 20));

    expect(rt.isActive()).toBe(true);
    await rt.unmount();
  });
});
