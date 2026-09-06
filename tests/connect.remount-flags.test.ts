/**
 * Regression: PR #59 reset `__connectTornDown` on onMount but left
 * `__connectFirstPass` / `__connectKickoffScheduled` sticky after onUnmount.
 * Same-instance remount then skipped user onMount and froze store→props updates.
 */
import { Component, connect, createStore } from 'Effectable';
import type { DispatchMethod } from 'Effectable';

type S = { n: number; mode: 'ok' | 'boom' };
type A = { type: 'INC' } | { type: 'BOOM' };

function makeStore (initial: S = { n: 0, mode: 'ok' }) {
  return createStore<S, A>((state = initial, action) => {
    if (action.type === 'INC') {
      return { ...state, n: state.n + 1 };
    }
    if (action.type === 'BOOM') {
      return { ...state, mode: 'boom', n: state.n + 1 };
    }
    return state;
  }, initial);
}

describe('connect remount / subscribe-error residuals (PR #59)', () => {
  test('mapState remount: user onMount runs again and store emits update props', () => {
    const store = makeStore();
    let userMounts = 0;
    class C extends Component<{ v?: number }, Record<string, never>> {
      public override onMount (): void {
        userMounts += 1;
      }
    }
    const Connected = connect(
      store,
      (s: S) => ({ v: s.n }),
    )(C);
    const inst = new Connected({});
    void inst.onMount!();
    expect(userMounts).toBe(1);
    expect(inst.props.v).toBe(0);

    void inst.onUnmount!();
    void inst.onMount!();
    expect(userMounts).toBe(2);

    store.dispatch({ type: 'INC' });
    expect(inst.props.v).toBe(1);
  });

  test('mapDispatch-only remount: post-mount kickoff runs again', async () => {
    const store = makeStore();
    let updates = 0;
    class C extends Component<{ inc?: () => void }, Record<string, never>> {
      public override onUpdate (): void {
        updates += 1;
      }
    }
    const Connected = connect(
      store,
      null,
      (dispatch: DispatchMethod<A>) => ({ inc: () => dispatch({ type: 'INC' }) }),
    )(C);
    const inst = new Connected({});
    void inst.onMount!();
    await Promise.resolve();
    expect(updates).toBe(1);

    void inst.onUnmount!();
    void inst.onMount!();
    await Promise.resolve();
    expect(updates).toBe(2);
  });

  test('sync onMount dispatch that makes mapState throw does not deliver onUpdate before failure', () => {
    const store = makeStore({ n: 0, mode: 'ok' });
    const events: string[] = [];
    class C extends Component<{ v?: number; mode?: string }, Record<string, never>> {
      public override onMount (): void {
        events.push('onMount');
        store.dispatch({ type: 'INC' });
        store.dispatch({ type: 'BOOM' });
      }
      public override onUpdate (): void {
        events.push('onUpdate');
      }
      public override onUnmount (): void {
        events.push('onUnmount');
      }
    }
    const Connected = connect(
      store,
      (s: S) => {
        if (s.mode === 'boom') {
          throw new Error('map boom');
        }
        return { v: s.n, mode: s.mode };
      },
    )(C);
    const inst = new Connected({});
    expect(() => {
      void inst.onMount!();
    }).toThrow('map boom');
    void inst.onUnmount!();
    expect(events).toEqual(['onMount', 'onUnmount']);
  });
});
