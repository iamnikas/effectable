/**
 * Nested HOC wrap `connect(...)(connect(...)(C))` used to stack-overflow in onMount:
 * outer field initializers wipe inner connect state, and capturing the inner own onMount
 * as `__connectOwnOnMount` made onMount recurse forever.
 */
import { Component, CONNECT_HOC_BRAND, connect, createStore } from '../src';

type S = { a: number; b: number };
type A = { type: 'SET_A'; n: number } | { type: 'SET_B'; n: number };

describe('connect nested HOC wrap', () => {
  test('connect(connect(C)) throws a clear error instead of stack-overflowing on mount', () => {
    const store = createStore<S, A>(
      (state = { a: 1, b: 10 }, action) => {
        if (action.type === 'SET_A') {
          return { ...state, a: action.n };
        }
        if (action.type === 'SET_B') {
          return { ...state, b: action.n };
        }
        return state;
      },
      { a: 1, b: 10 },
    );

    class Base extends Component<Partial<S>, Record<string, never>> {}
    const Once = connect(store, (s: S) => ({ a: s.a }))(Base);

    expect((Once as unknown as { [CONNECT_HOC_BRAND]?: boolean })[CONNECT_HOC_BRAND]).toBe(true);

    expect(() => connect(store, (s: S) => ({ b: s.b }))(Once)).toThrow(
      /Cannot wrap an already-connected component/,
    );
  });

  test('single connect still mounts and updates', () => {
    const store = createStore<S, A>(
      (state = { a: 1, b: 10 }, action) => {
        if (action.type === 'SET_A') {
          return { ...state, a: action.n };
        }
        return state;
      },
      { a: 1, b: 10 },
    );

    class Base extends Component<{ a?: number }, Record<string, never>> {}
    const Connected = connect(store, (s: S) => ({ a: s.a }))(Base);
    const inst = new Connected({});

    expect(() => {
      void inst.onMount!();
    }).not.toThrow();
    expect(inst.props.a).toBe(1);

    store.dispatch({ type: 'SET_A', n: 3 });
    expect(inst.props.a).toBe(3);

    void inst.onUnmount!();
  });
});
