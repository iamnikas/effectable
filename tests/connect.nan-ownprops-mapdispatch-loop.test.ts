/**
 * shallowEqualOwnProps uses !==, so stable NaN own-props always look "changed".
 * With a connected parent, a side-effecting child mapDispatch closes a loop:
 * mapDispatch → dispatch → parent select → setState → compose → RUNTIME_PROPS_RECEIVER
 * → mapDispatch → … → GraphRuntime fail-stop.
 *
 * Distinct from #91 (applyToScope dirty re-sync) and #107 (nested mapDispatch without
 * own-props shallow gate): the gate exists but uses !== instead of Object.is.
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

describe('connect NaN own-props vs mapDispatch side-effect', () => {
  it('stable NaN own prop + connected parent must not fail-stop GraphRuntime', async () => {
    const store = createStore<S, A>(
      (state = { n: 0 }, action) => (action.type === 'INC' ? { n: state.n + 1 } : state),
      { n: 0 },
    );

    let mapDispatchCalls = 0;

    class ChildHost extends Component<object, { score?: number; n?: number; bump?: () => void }> {
      public override compose () {
        return [];
      }
    }

    const ConnectedChild = connect(
      (s: S) => ({ n: s.n }),
      (dispatch: (a: A) => A, _props: { score: number }) => {
        mapDispatchCalls += 1;
        dispatch({ type: 'INC' });
        return {
          bump: () => dispatch({ type: 'INC' }),
        };
      },
    )(ChildHost);

    class ParentHost extends Component<{ n?: number }, { score: number }> {
      public override compose () {
        return [h(ConnectedChild, { score: Number.NaN })];
      }
    }

    const ConnectedParent = connect(
      store,
      (s: S) => ({ n: s.n }),
    )(ParentHost);

    const rt = await GraphRuntime.mount(h(ConnectedParent, {}));
    // Give the dirty/select loop time to fail-stop if NaN keeps mapDispatch hot.
    await new Promise<void>((r) => setTimeout(r, 50));

    expect(rt.isActive()).toBe(true);
    expect(rt.getState()).toBe('active');
    // Mount may invoke mapDispatch once (or twice with kickoff); must stay bounded.
    expect(mapDispatchCalls).toBeLessThan(10);

    await rt.unmount();
    store.destroy();
  });
});
