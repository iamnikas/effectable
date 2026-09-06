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

  // #129 regression: options in the mapState slot must not swallow a following mapDispatch.
  // connect(store, { ownPropsModeMerge }, mapDispatch) is type-legal after ConnectOptions was
  // added to the 2nd-arg union; the first implementation assigned options and ignored arg3.
  test('store form: connect(store, options, mapDispatch) keeps dispatch and merges', () => {
    const store = makeStore();
    class Host extends Component<
      Record<string, never>,
      { label?: string; inc?: () => void }
    > {}

    const Connected = connect(
      store,
      { ownPropsModeMerge: true },
      (dispatch: DispatchMethod<A>) => ({
        inc: (): void => {
          dispatch({ type: 'INC' });
        },
      }),
    )(Host);

    const inst = new Connected({ label: 'keep-me' });
    void inst.onMount!();
    expect(inst.props.label).toBe('keep-me');
    expect(typeof inst.props.inc).toBe('function');
    inst.props.inc!();
    expect(store.getState().n).toBe(1);
  });

  test('store form: connect(store, options, actionCreators) binds creators', () => {
    const store = makeStore();
    class Host extends Component<
      Record<string, never>,
      { label?: string; go?: () => void }
    > {}

    const Connected = connect(
      store,
      { ownPropsModeMerge: true },
      {
        go: (): A => ({ type: 'INC' }),
      },
    )(Host);

    const inst = new Connected({ label: 'x' });
    void inst.onMount!();
    expect(inst.props.label).toBe('x');
    expect(typeof inst.props.go).toBe('function');
    inst.props.go!();
    expect(store.getState().n).toBe(1);
  });

  test('child form: connect(options, mapDispatch) keeps dispatch and merges', () => {
    const store = makeStore();
    class Host extends Component<
      Record<string, never>,
      { label?: string; inc?: () => void }
    > {}

    const ConnectedChild = connect(
      { ownPropsModeMerge: true },
      (dispatch: DispatchMethod<A>) => ({
        inc: (): void => {
          dispatch({ type: 'INC' });
        },
      }),
    )(Host);

    const inst = new ConnectedChild({ label: 'child' }) as InstanceType<typeof ConnectedChild> & {
      __connectStoreFromContext?: unknown;
    };
    inst.__connectStoreFromContext = store;
    void inst.onMount!();
    expect(inst.props.label).toBe('child');
    expect(typeof inst.props.inc).toBe('function');
    inst.props.inc!();
    expect(store.getState().n).toBe(1);
  });
});
