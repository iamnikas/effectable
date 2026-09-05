/**
 * Reproduction: first BehaviorSubject emission runs super.onMount inside subscribe()
 * before the Subscription handle is assigned to `__connectSubscription`.
 *
 * Without a post-subscribe ownership check:
 * - onUnmount during first-pass leaves a live subscription (selector keeps running)
 * - nested onUnmount → onMount remount lets the outer subscribe() overwrite the new
 *   handle with the old one, leaking the remount subscription and double-firing updates
 */
import { Component, connect, createStore } from 'Effectable';

type S = { n: number };
type A = { type: 'INC' };

function makeStore (initial: S = { n: 0 }) {
  return createStore<S, A>((state = initial, action) => {
    if (action.type === 'INC') {
      return { ...state, n: state.n + 1 };
    }
    return state;
  }, initial);
}

describe('connect first-pass subscription assign race', () => {
  test('onUnmount during first-pass must not leave a live store subscription', () => {
    const store = makeStore();
    const updates: number[] = [];
    let selectorRuns = 0;

    class C extends Component<{ n?: number }, Record<string, never>> {
      public override onMount (): void {
        // Abort during first-pass next while __connectSubscription is still null
        void this.onUnmount!();
      }

      public override onUpdate (): void {
        updates.push(this.props.n as number);
      }
    }

    const Connected = connect(store, (s: S) => {
      selectorRuns += 1;
      return { n: s.n };
    })(C);

    const inst = new Connected({});
    inst.onMount();

    const before = selectorRuns;
    store.dispatch({ type: 'INC' });

    expect(selectorRuns - before).toBe(0);
    expect(updates).toEqual([]);
    expect(
      (inst as unknown as { __connectSubscription: unknown }).__connectSubscription
    ).toBeNull();
  });

  test('nested remount during first-pass must not double-subscribe', () => {
    const store = makeStore();
    const updates: number[] = [];
    let nested = false;
    let selectorRuns = 0;

    class C extends Component<{ n?: number }, Record<string, never>> {
      public override onMount (): void {
        if (!nested) {
          nested = true;
          void this.onUnmount!();
          void this.onMount!();
        }
      }

      public override onUpdate (): void {
        updates.push(this.props.n as number);
      }
    }

    const Connected = connect(store, (s: S) => {
      selectorRuns += 1;
      return { n: s.n };
    })(C);

    const inst = new Connected({});
    inst.onMount();

    const before = selectorRuns;
    store.dispatch({ type: 'INC' });

    expect(updates).toEqual([1]);
    expect(selectorRuns - before).toBe(1);
  });
});
