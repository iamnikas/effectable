/**
 * After store.destroy(), a root-connected parent stays ACTIVE (#106) and still
 * republishes the destroyed store into context. PLACE'ing a new context-connected
 * child must not fail-stop GraphRuntime.
 *
 * Root cause (pre-fix): tryResolveConnectStore adopted the context store without a
 * getState() liveness probe, then syncConnectPropsBeforeCompose → getState() threw
 * during PLACE materialization / nested onMount and fail-stopped the whole tree.
 *
 * Distinct from #87 (explicit-store mount on already-destroyed store must reject).
 * Distinct from #106 (same instance post-destroy reconcile).
 * Distinct from #112 (mapDispatch-only explicit mount on destroyed store).
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

describe('connect: context child PLACE after store.destroy', () => {
  it('mapState context child PLACE after destroy must keep GraphRuntime active', async () => {
    const store = createStore<S, A>(
      (state = { n: 0 }, action) => (action.type === 'INC' ? { n: state.n + 1 } : state),
      { n: 0 },
    );

    class Leaf extends Component<object, { n?: number }> {
      public override compose () {
        return [];
      }
    }

    const ConnectedLeaf = connect((s: S) => ({ n: s.n }))(Leaf);

    class Root extends Component<{ show: boolean; n?: number }, object> {
      public constructor (props: object) {
        super(props);
        this.state = { show: false };
      }

      public override compose () {
        return this.state.show ? [h(ConnectedLeaf, {})] : [];
      }
    }

    const ConnectedRoot = connect(store, (s: S) => ({ n: s.n }))(Root);

    const rt = await GraphRuntime.mount(h(ConnectedRoot, {}));
    expect(rt.isActive()).toBe(true);

    store.destroy();

    const root = rt.getRootInstance() as Root;
    root.setState({ show: true });
    await new Promise<void>((r) => setTimeout(r, 30));

    expect(rt.isActive()).toBe(true);
    expect(rt.getState()).toBe('active');

    await rt.unmount();
  });

  it('explicit-store mapState mount on destroyed store still rejects (#87)', async () => {
    const store = createStore<S, A>(
      (state = { n: 0 }) => state,
      { n: 0 },
    );
    store.destroy();

    class Gate extends Component<object, { n?: number }> {
      public override compose () {
        return [];
      }
    }

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Gate);

    await expect(GraphRuntime.mount(h(Connected, {}))).rejects.toThrow(
      /completed before the first state emission|destroyed/i,
    );
  });
});
