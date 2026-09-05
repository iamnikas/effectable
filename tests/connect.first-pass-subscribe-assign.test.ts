/**
 * Regression: BehaviorSubject first emission runs super.onMount before
 * `subscribe()` returns, so `__connectSubscription` is still null.
 * onUnmount/dispose during that window cannot unsubscribe; assigning the
 * returned Subscription afterward can revive a torn-down mount or clobber a
 * nested remount's live subscription.
 *
 * @module Effectable/connect/connect.first-pass-subscribe-assign.test
 */
import { Component, connect, createStore } from 'Effectable';

describe('connect first-pass subscribe assign race', () => {
  it('ABORT: onUnmount during sync onMount must dispose the subscription created mid-onMount', () => {
    const store = createStore((s: { n: number } | undefined, a: { type: string }): { n: number } => {
      if (typeof s === 'undefined') return { n: 0 };
      if (a.type === 'INC') return { n: s.n + 1 };
      return s;
    }, { n: 0 });

    let mapCalls = 0;
    let updates = 0;

    class Svc extends Component<{ n?: number }, Record<string, never>> {
      public override onMount (): void {
        this.onUnmount!();
      }

      public override onUpdate (): void {
        updates += 1;
      }
    }

    const Connected = connect(store, (s: { n: number }) => {
      mapCalls += 1;
      return { n: s.n };
    })(Svc);
    const inst = new Connected({});
    inst.onMount!();
    const mapsAfterAbort = mapCalls;

    store.dispatch({ type: 'INC' });
    store.dispatch({ type: 'INC' });

    expect(updates).toBe(0);
    // Post-abort dispatches must not re-enter mapState (subscription disposed).
    expect(mapCalls).toBe(mapsAfterAbort);
    store.destroy();
  });

  it('NESTED-REMOUNT: outer subscribe return must not clobber nested subscription', () => {
    const store = createStore((s: { n: number } | undefined, a: { type: string }): { n: number } => {
      if (typeof s === 'undefined') return { n: 0 };
      if (a.type === 'INC') return { n: s.n + 1 };
      return s;
    }, { n: 0 });

    let updates = 0;
    let nested = false;

    class Svc extends Component<{ n?: number }, Record<string, never>> {
      public override onMount (): void {
        if (!nested) {
          nested = true;
          this.onUnmount!();
          this.onMount!();
        }
      }

      public override onUpdate (): void {
        updates += 1;
      }
    }

    const Connected = connect(store, (s: { n: number }) => ({ n: s.n }))(Svc);
    const inst = new Connected({});
    inst.onMount!();

    const before = updates;
    store.dispatch({ type: 'INC' });
    // Exactly one post-mount delivery path (not double-fire from S1+S2).
    expect(updates - before).toBe(1);

    inst.onUnmount!();
    const mid = updates;
    store.dispatch({ type: 'INC' });
    expect(updates).toBe(mid);

    store.destroy();
  });
});
