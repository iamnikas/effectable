/**
 * Sync first-pass `onMount` can call `onUnmount` / remount before `subscribe()`
 * returns. `disposeConnectSubscription` then no-ops (`__connectSubscription` is
 * still null), and assigning the returned Subscription leaves a zombie — or, on
 * nested remount, an outer subscription that never gets disposed.
 */
import { Component, connect, createStore } from 'Effectable';

type S = { n: number };
type A = { type: 'INC' };

describe('connect subscribe-assign race (first-pass tear-down / remount)', () => {
  test('onUnmount during first-pass onMount must not leave a live subscription', () => {
    const store = createStore<S, A>(
      (state = { n: 0 }, action) => (action.type === 'INC' ? { n: state.n + 1 } : state),
      { n: 0 },
    );

    let mapCalls = 0;

    class C extends Component<{ v?: number }, Record<string, never>> {
      public override onMount (): void {
        // Abort during first mapState emission, before subscribe() returns.
        this.onUnmount();
      }
    }

    const Connected = connect(
      store,
      (s: S) => {
        mapCalls += 1;
        return { v: s.n };
      },
    )(C);

    const inst = new Connected({});
    inst.onMount();

    const before = mapCalls;
    store.dispatch({ type: 'INC' });
    expect(mapCalls).toBe(before);
  });

  test('nested remount during first-pass must not keep outer subscription alive', () => {
    const store = createStore<S, A>(
      (state = { n: 0 }, action) => (action.type === 'INC' ? { n: state.n + 1 } : state),
      { n: 0 },
    );

    let mapCalls = 0;
    let nested = false;

    class C extends Component<{ v?: number }, Record<string, never>> {
      public override onMount (): void {
        if (nested) {
          return;
        }
        nested = true;
        this.onUnmount();
        this.onMount();
      }
    }

    const Connected = connect(
      store,
      (s: S) => {
        mapCalls += 1;
        return { v: s.n };
      },
    )(C);

    const inst = new Connected({});
    inst.onMount();
    expect(inst.props.v).toBe(0);

    const before = mapCalls;
    store.dispatch({ type: 'INC' });
    expect(mapCalls - before).toBe(1);
    expect(inst.props.v).toBe(1);
  });
});
