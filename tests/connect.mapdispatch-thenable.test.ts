/**
 * Regression: mapDispatchToProps factory returning a Promise/thenable must not be
 * installed as `__connectDispatchProps`.
 *
 * Distinct from mapState thenable (#156 / getMappedPropsRecord): resolveMapDispatchProps
 * has its own object gate and did not share that check. Mount succeeded with
 * `__connectDispatchProps` holding a Promise and `this.props` missing every bound
 * action creator (silent loss of dispatch props).
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';
import type { DispatchMethod } from 'Effectable';

type HostProps = { inc?: () => void };

interface State {
  n: number;
}

type TestAction = { type: 'INC' };

describe('connect mapDispatchToProps thenable rejection', () => {
  it('fails mount when mapDispatch factory returns a Promise', async () => {
    const store = createStore<State, TestAction>(
      (state = { n: 0 }, action) =>
        (action.type === 'INC' ? { n: state.n + 1 } : state),
      { n: 0 },
    );

    class Host extends Component<HostProps, Record<string, never>> {
      public constructor (props: Record<string, never>) {
        super(props);
      }
    }

    const Connected = connect(
      store,
      null,
      async (dispatch: DispatchMethod<TestAction>) => ({
        inc: () => dispatch({ type: 'INC' }),
      }),
    )(Host);

    await expect(GraphRuntime.mount(h(Connected, {}))).rejects.toThrow(
      /mapDispatchToProps must return a plain object synchronously/,
    );

    store.destroy();
  });

  it('still binds a synchronous mapDispatch factory', async () => {
    const store = createStore<State, TestAction>(
      (state = { n: 0 }, action) =>
        (action.type === 'INC' ? { n: state.n + 1 } : state),
      { n: 0 },
    );

    class Host extends Component<HostProps, Record<string, never>> {
      public constructor (props: Record<string, never>) {
        super(props);
      }
    }

    const Connected = connect(
      store,
      null,
      (dispatch: DispatchMethod<TestAction>) => ({
        inc: () => dispatch({ type: 'INC' }),
      }),
    )(Host);

    const rt = await GraphRuntime.mount(h(Connected, {}));
    const inst = rt.getRootInstance();
    if (inst === null) {
      throw new Error('expected root instance');
    }
    const inc = (inst.props as HostProps).inc;
    expect(typeof inc).toBe('function');
    if (inc === undefined) {
      throw new Error('expected bound inc');
    }
    inc();
    expect(store.getState().n).toBe(1);
    await rt.unmount();
    store.destroy();
  });
});
