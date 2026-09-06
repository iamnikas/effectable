/**
 * Regression: `connect(store, mapState, { ownPropsModeMerge: true })` is type-legal
 * (3rd arg is `MapDispatchToProps | ConnectOptions`) but previously treated the options
 * bag as an action-creators map, left `options` undefined, and silently stayed in
 * strict mode — own props were dropped. Same for child `connect(mapState, options)`.
 *
 * Component generics are `<State, Props>`.
 */
import { Component, connect, createStore } from 'Effectable';
import type { DispatchMethod } from 'Effectable';

type S = { n: number };
type A = { type: 'INC' };

function makeStore () {
  return createStore<S, A>(
    (state = { n: 0 }, action) => (action.type === 'INC' ? { n: state.n + 1 } : state),
    { n: 0 },
  );
}

describe('connect options overload (ownPropsModeMerge without null mapDispatch)', () => {
  test('store form: connect(store, mapState, { ownPropsModeMerge: true }) merges own props', () => {
    const store = makeStore();
    class Host extends Component<Record<string, never>, { n?: number; label?: string }> {}

    const Connected = connect(
      store,
      (s: S) => ({ n: s.n }),
      { ownPropsModeMerge: true },
    )(Host);

    const inst = new Connected({ label: 'keep-me' });
    void inst.onMount!();
    expect(inst.props.n).toBe(0);
    expect(inst.props.label).toBe('keep-me');
  });

  test('store form: explicit null mapDispatch + options still merges', () => {
    const store = makeStore();
    class Host extends Component<Record<string, never>, { n?: number; label?: string }> {}

    const Connected = connect(
      store,
      (s: S) => ({ n: s.n }),
      null,
      { ownPropsModeMerge: true },
    )(Host);

    const inst = new Connected({ label: 'keep-me' });
    void inst.onMount!();
    expect(inst.props.label).toBe('keep-me');
  });

  test('store form: connect(store, mapState, mapDispatch, options) unchanged', () => {
    const store = makeStore();
    class Host extends Component<
      Record<string, never>,
      { n?: number; label?: string; inc?: () => void }
    > {}

    const Connected = connect(
      store,
      (s: S) => ({ n: s.n }),
      (dispatch: DispatchMethod<A>) => ({
        inc: (): void => {
          dispatch({ type: 'INC' });
        },
      }),
      { ownPropsModeMerge: true },
    )(Host);

    const inst = new Connected({ label: 'x' });
    void inst.onMount!();
    expect(inst.props.label).toBe('x');
    expect(typeof inst.props.inc).toBe('function');
  });

  test('child form: connect(mapState, { ownPropsModeMerge: true }) merges own props', () => {
    const store = makeStore();
    class Host extends Component<Record<string, never>, { n?: number; label?: string }> {}

    const ConnectedChild = connect(
      (s: S) => ({ n: s.n }),
      { ownPropsModeMerge: true },
    )(Host);

    const inst = new ConnectedChild({ label: 'child-label' }) as InstanceType<typeof ConnectedChild> & {
      __connectStoreFromContext?: unknown;
    };
    inst.__connectStoreFromContext = store;
    void inst.onMount!();
    expect(inst.props.n).toBe(0);
    expect(inst.props.label).toBe('child-label');
  });

  test('action-creators map with a function value is not treated as ConnectOptions', () => {
    const store = makeStore();
    class Host extends Component<Record<string, never>, { n?: number; go?: () => void }> {}

    // Function values → action-creators map, even if ownPropsModeMerge key exists.
    const Connected = connect(
      store,
      (s: S) => ({ n: s.n }),
      {
        ownPropsModeMerge: (() => ({ type: 'INC' })) as unknown as () => A,
        go: (): A => ({ type: 'INC' }),
      },
    )(Host);

    const inst = new Connected({});
    void inst.onMount!();
    expect(inst.props.n).toBe(0);
    expect(typeof (inst.props as { go?: unknown }).go).toBe('function');
  });
});
