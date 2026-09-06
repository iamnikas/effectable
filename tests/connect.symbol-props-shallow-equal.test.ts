/**
 * Symbol-keyed mapState / own-props must participate in connect shallow equality.
 *
 * `Object.keys`-only compare treated Symbol-only (or mixed string+Symbol) updates as
 * unchanged → applyMappedStateProps / mapDispatch refresh skipped → silent lost writes.
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';

describe('connect Symbol-keyed props shallow equality', () => {
  const TOKEN = Symbol('effectable.connect.token');

  type S = { n: number; t: string };
  type A =
    | { type: 'INC' }
    | { type: 'SET_T'; payload: string };

  function makeStore () {
    return createStore<S, A>((state, action) => {
      if (action.type === 'INC') {
        return { ...state, n: state.n + 1 };
      }
      if (action.type === 'SET_T') {
        return { ...state, t: action.payload };
      }
      return state;
    }, { n: 0, t: 'a' });
  }

  it('Symbol-only mapState updates reach this.props after store emit', async () => {
    const store = makeStore();
    class Host extends Component<
      Record<string | symbol, unknown>,
      Record<string | symbol, unknown>
    > {
      public override compose () {
        return null;
      }
    }
    const Connected = connect(
      store,
      (s: S) => ({ [TOKEN]: s.n } as Record<symbol, number>),
    )(Host);

    const inst = new Connected({});
    await inst.onMount!();
    expect(inst.props[TOKEN]).toBe(0);
    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    expect(inst.props[TOKEN]).toBe(1);
    await inst.onUnmount!();
    store.destroy();
  });

  it('mixed string+Symbol mapState — Symbol change with stable string keys updates props', async () => {
    const store = makeStore();
    class Host extends Component<
      Record<string | symbol, unknown>,
      Record<string | symbol, unknown>
    > {
      public override compose () {
        return null;
      }
    }
    const Connected = connect(
      store,
      (s: S) => ({ n: s.n, [TOKEN]: s.t }),
    )(Host);

    const inst = new Connected({});
    await inst.onMount!();
    expect(inst.props[TOKEN]).toBe('a');
    store.dispatch({ type: 'SET_T', payload: 'b' });
    await Promise.resolve();
    expect(inst.props[TOKEN]).toBe('b');
    await inst.onUnmount!();
    store.destroy();
  });

  it('parent Symbol own-prop change refreshes mapped props under GraphRuntime', async () => {
    const store = makeStore();
    const seen: unknown[] = [];

    class Child extends Component<
      Record<string | symbol, unknown>,
      Record<string | symbol, unknown>
    > {
      public override onUpdate (): void {
        seen.push(this.props[TOKEN]);
      }

      public override compose () {
        return null;
      }
    }

    const Connected = connect(
      store,
      (s: S, own: Record<string | symbol, unknown>) => ({
        n: s.n,
        [TOKEN]: own[TOKEN],
      }),
    )(Child);

    class Parent extends Component<{ v: string }, { v: string }> {
      public override compose () {
        return h(Connected, { [TOKEN]: this.props.v } as never, 'c');
      }
    }

    const runtime = await GraphRuntime.mount(h(Parent, { v: 'a' }));
    await runtime.reconcile(h(Parent, { v: 'b' }));
    expect(seen).toContain('b');
    await runtime.unmount();
    store.destroy();
  });

  it('Symbol-keyed action creator map binds dispatch callback', async () => {
    const store = makeStore();
    const INC = Symbol('inc');
    class Host extends Component<
      Record<string | symbol, unknown>,
      Record<string | symbol, unknown>
    > {
      public override compose () {
        return null;
      }
    }
    const Connected = connect(
      store,
      null,
      { [INC]: () => ({ type: 'INC' as const }) } as never,
    )(Host);

    const inst = new Connected({});
    await inst.onMount!();
    expect(typeof inst.props[INC]).toBe('function');
    (inst.props[INC] as () => void)();
    expect(store.getState().n).toBe(1);
    await inst.onUnmount!();
    store.destroy();
  });
});
