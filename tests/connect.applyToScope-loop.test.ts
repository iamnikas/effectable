/**
 * Regression (#85 follow-up): syncing mapped props inside `applyToScope` must not
 * re-run on every dirty reconcile after mount.
 *
 * If `mapDispatchToProps` (function form) dispatches as a side effect, re-running it
 * from dirty `applyToScope` loops: dispatch → select → setState → dirty flush →
 * applyToScope → dispatch → … until GraphRuntime fail-stop.
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';
import type { DispatchMethod } from 'Effectable';

describe('connect applyToScope mapDispatch side-effect', () => {
  type S = { n: number; tick: number };
  type A = { type: 'TICK' } | { type: 'INC' };

  it('mapDispatch factory dispatch does not fail-stop the runtime', async () => {
    let mapDispatchCalls = 0;
    const store = createStore<S, A>(
      (state, action) => {
        if (action.type === 'TICK') {
          return { ...state, tick: state.tick + 1 };
        }
        if (action.type === 'INC') {
          return { ...state, n: state.n + 1 };
        }
        return state;
      },
      { n: 0, tick: 0 },
    );

    class Host extends Component<object, { n?: number }> {
      public override compose () {
        return [];
      }
    }

    const Connected = connect(
      store,
      (s: S) => ({ n: s.n }),
      (dispatch: DispatchMethod<A>) => {
        mapDispatchCalls += 1;
        dispatch({ type: 'TICK' });
        return {
          inc: () => dispatch({ type: 'INC' }),
        };
      },
    )(Host);

    const runtime = await GraphRuntime.mount(h(Connected, {}));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(runtime.getState()).toBe('active');
    // applyToScope (pre-mount) + onMount refresh — not dozens of dirty re-entries.
    expect(mapDispatchCalls).toBeLessThan(10);
    expect(store.getState().tick).toBe(mapDispatchCalls);

    await runtime.unmount();
  });

  it('still strips strict own-props before the first compose', async () => {
    const store = createStore<S, A>(
      (state, action) => (action.type === 'INC' ? { ...state, n: state.n + 1 } : state),
      { n: 0, tick: 0 },
    );
    const log: string[] = [];

    class Gate extends Component<object, { adminToken?: string; n?: number }> {
      public override compose () {
        log.push(`token=${String(this.props.adminToken)}`);
        return [];
      }
    }

    const ConnectedGate = connect(store, (s: S) => ({ n: s.n }))(Gate);
    const runtime = await GraphRuntime.mount(
      h(ConnectedGate, { adminToken: 'SECRET' }),
    );

    expect(log[0]).toBe('token=undefined');
    await runtime.unmount();
  });
});
