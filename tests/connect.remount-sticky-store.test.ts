/**
 * Residual: child-connected instances cache the store resolved from
 * context into `__connectStore` and never cleared it on remount, so remount
 * under a different provider kept driving props from the old store.
 */
import { Component, connect, createStore } from 'Effectable';

type S = { n: number };
type A = { type: 'INC' };

describe('connect remount sticky context store', () => {
  test('remount under a different context store re-resolves and tracks the new store', () => {
    const storeA = createStore<S, A>(
      (state = { n: 0 }, action) => (action.type === 'INC' ? { n: state.n + 1 } : state),
      { n: 0 },
    );
    const storeB = createStore<S, A>(
      (state = { n: 100 }, action) => (action.type === 'INC' ? { n: state.n + 1 } : state),
      { n: 100 },
    );

    class C extends Component<{ v?: number }, Record<string, never>> {}
    const Connected = connect((s: S) => ({ v: s.n }))(C);
    const inst = new Connected({}) as InstanceType<typeof Connected> & {
      __connectStoreFromContext?: unknown;
    };

    inst.__connectStoreFromContext = storeA;
    void inst.onMount!();
    expect(inst.props.v).toBe(0);

    void inst.onUnmount!();
    inst.__connectStoreFromContext = storeB;
    void inst.onMount!();
    expect(inst.props.v).toBe(100);

    storeB.dispatch({ type: 'INC' });
    expect(inst.props.v).toBe(101);

    storeA.dispatch({ type: 'INC' });
    expect(inst.props.v).toBe(101);
  });
});
