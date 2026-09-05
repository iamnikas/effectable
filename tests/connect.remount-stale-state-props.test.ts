/**
 * Residual after remount flag resets: remount cleared prevMapped / flags but left
 * `__connectStateProps` from the previous mount. refreshDispatchProps then
 * rebuilt this.props with stale mapped fields; if the first remount emission
 * was a non-object, those fields stayed stuck.
 */
import { Component, connect, createStore } from 'Effectable';

type S = { n: number; mode: 'obj' | 'null' };
type A = { type: 'TO_NULL' } | { type: 'TO_OBJ' } | { type: 'INC' };

function makeStore (initial: S = { n: 1, mode: 'obj' }) {
  return createStore<S, A>((state = initial, action) => {
    if (action.type === 'TO_NULL') {
      return { ...state, mode: 'null' };
    }
    if (action.type === 'TO_OBJ') {
      return { ...state, mode: 'obj', n: state.n + 1 };
    }
    if (action.type === 'INC') {
      return { ...state, n: state.n + 1 };
    }
    return state;
  }, initial);
}

describe('connect remount stale __connectStateProps', () => {
  test('invalid first mapState emission after remount must not keep previous mount state props', () => {
    const store = makeStore();

    class C extends Component<{ v?: number }, Record<string, never>> {}

    const Connected = connect(
      store,
      (s: S) => {
        if (s.mode === 'null') {
          return null as unknown as { v: number };
        }
        return { v: s.n };
      },
    )(C);

    const inst = new Connected({});
    void inst.onMount!();
    expect(inst.props.v).toBe(1);

    void inst.onUnmount!();
    store.dispatch({ type: 'TO_NULL' });
    void inst.onMount!();

    expect(inst.props.v).toBeUndefined();
  });

  test('valid remount still refreshes state props from the current store', () => {
    const store = makeStore();

    class C extends Component<{ v?: number }, Record<string, never>> {}

    const Connected = connect(
      store,
      (s: S) => ({ v: s.n }),
    )(C);

    const inst = new Connected({});
    void inst.onMount!();
    expect(inst.props.v).toBe(1);

    void inst.onUnmount!();
    store.dispatch({ type: 'INC' });
    void inst.onMount!();
    expect(inst.props.v).toBe(2);
  });
});
