/**
 * Regression: nested same-instance remount during the first BehaviorSubject
 * emission must not orphan a zombie store subscription.
 *
 * store.select().subscribe() emits synchronously. Connect used to assign
 * `__connectSubscription` only after subscribe() returned, so onUnmount during
 * that first next could not dispose the outer sub, and a nested onMount's sub
 * was then clobbered by the outer assign — double onUpdate forever after.
 */
import { Component, connect, createStore } from '../src/index';

type S = { n: number };
type A = { type: 'INC' };

describe('connect first-pass subscribe assign race', () => {
  test('nested remount during sync onMount does not double-deliver store updates', () => {
    const store = createStore<S, A>(
      (state = { n: 0 }, action) => (action.type === 'INC' ? { n: state.n + 1 } : state),
      { n: 0 },
    );

    const updates: number[] = [];
    let nestedOnce = true;

    class C extends Component<{ v?: number }, Record<string, never>> {
      public override onMount (): void {
        if (nestedOnce) {
          nestedOnce = false;
          this.onUnmount!();
          this.onMount!();
        }
      }

      public override onUpdate (): void {
        updates.push(this.props.v ?? -1);
      }
    }

    const Connected = connect(store, (s: S) => ({ v: s.n }))(C);
    const inst = new Connected({});
    inst.onMount!();

    store.dispatch({ type: 'INC' });
    expect(updates).toEqual([1]);

    inst.onUnmount!();
    updates.length = 0;
    nestedOnce = false;
    inst.onMount!();
    store.dispatch({ type: 'INC' });
    expect(updates).toEqual([2]);

    inst.onUnmount!();
    const after = updates.length;
    store.dispatch({ type: 'INC' });
    expect(updates.length).toBe(after);
  });

  test('onUnmount-only during first next does not leave a live outer subscription', () => {
    const store = createStore<S, A>(
      (state = { n: 0 }, action) => (action.type === 'INC' ? { n: state.n + 1 } : state),
      { n: 0 },
    );

    const updates: number[] = [];

    class C extends Component<{ v?: number }, Record<string, never>> {
      public override onMount (): void {
        this.onUnmount!();
      }

      public override onUpdate (): void {
        updates.push(this.props.v ?? -1);
      }
    }

    const Connected = connect(store, (s: S) => ({ v: s.n }))(C);
    const inst = new Connected({});
    inst.onMount!();

    store.dispatch({ type: 'INC' });
    expect(updates).toEqual([]);
  });
});
