/**
 * After post-mount store.destroy(), a root-connected host still republishes the
 * destroyed store into CONNECT_STORE_CONTEXT (#106). A NEW child-connected descendant
 * that first resolves that store from context must not call getState() during
 * pre-compose sync — that throw fail-stops the entire GraphRuntime.
 *
 * Uses ownPropsModeMerge so parent own-props still flow after destroy (mapState
 * cannot re-run; strict mode would keep last mapped showChild=false and skip PLACE).
 *
 * Distinct from #106 (explicit/cached store on an already-mounted host).
 * Distinct from #112 (mapDispatch-only mount on an explicitly destroyed store).
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

describe('connect destroyed-store context + new child PLACE', () => {
  it('child-connected mapState PLACE under destroyed context must keep GraphRuntime active', async () => {
    const store = createStore<S, A>(
      (state = { n: 0 }, action) => (action.type === 'INC' ? { n: state.n + 1 } : state),
      { n: 0 },
    );

    class ChildHost extends Component<object, { v: number; n?: number }> {
      public override compose () {
        return [];
      }
    }

    const ConnectedChild = connect(
      (s: S, p: { v: number }) => ({ n: s.n, v: p.v }),
    )(ChildHost);

    class RootHost extends Component<object, { showChild?: boolean; v?: number; n?: number }> {
      public override compose () {
        if (!this.props.showChild) {
          return [];
        }
        return [h(ConnectedChild, { v: this.props.v ?? 0 })];
      }
    }

    const ConnectedRoot = connect(
      store,
      (s: S) => ({ n: s.n }),
      null,
      { ownPropsModeMerge: true },
    )(RootHost);

    class Parent extends Component<{ showChild: boolean; v: number }, object> {
      public constructor (props: object) {
        super(props);
        this.state = { showChild: false, v: 1 };
      }

      public override compose () {
        return [h(ConnectedRoot, { showChild: this.state.showChild, v: this.state.v })];
      }
    }

    const rt = await GraphRuntime.mount(h(Parent, {}));
    expect(rt.isActive()).toBe(true);

    store.destroy();

    const parent = rt.getRootInstance() as Parent;
    parent.setState({ showChild: true, v: 2 });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 30);
    });

    expect(rt.isActive()).toBe(true);
    expect(rt.getState()).toBe('active');

    await rt.unmount();
  });
});
