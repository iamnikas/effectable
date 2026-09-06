/**
 * Regression: mapStateToProps (and mapDispatch) returning a thenable must not be
 * treated as a props record. `typeof promise === 'object'`, so the old gate
 * accepted it; spreading a Promise into props copies no enumerable keys and
 * silently drops every mapped field.
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';

type State = { n: number };

describe('connect mapState thenable rejection', () => {
  it('does not mount with silently empty mapped props when mapState returns a Promise', async () => {
    const store = createStore(
      (s: State | undefined): State => s ?? { n: 1 },
      { n: 1 },
    );

    const mapState = ((state: State) =>
      Promise.resolve({ n: state.n * 10 })) as unknown as (s: State) => { n: number };

    const Connected = connect(store, mapState)(
      class extends Component<{ n?: number }, { n?: number }> {},
    );

    await expect(GraphRuntime.mount(h(Connected as never, {}))).rejects.toThrow(
      /thenables are not supported/,
    );

    store.destroy();
  });

  it('still applies a synchronous plain object from mapState', async () => {
    const store = createStore(
      (s: State | undefined): State => s ?? { n: 1 },
      { n: 1 },
    );

    const Connected = connect(store, (s: State) => ({ n: s.n * 10 }))(
      class extends Component<{ n?: number }, { n?: number }> {},
    );

    const rt = await GraphRuntime.mount(h(Connected as never, {}));
    const inst = rt.getRootInstance() as Component<{ n?: number }, { n?: number }>;
    expect(inst.props.n).toBe(10);
    await rt.unmount();
    store.destroy();
  });
});
