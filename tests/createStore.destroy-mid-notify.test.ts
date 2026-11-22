/**
 * Regression: destroy() during state$ notification must not skip later observers.
 *
 * BehaviorSubject.complete() mid-next drops not-yet-delivered subscribers for that
 * emission. createStore must defer complete until the current publish finishes so
 * connect selects (and raw state$ subscribers) still receive the destroying emission.
 */
import { Component, connect, createStore } from 'Effectable';
import type { DispatchMethod } from 'Effectable';

type S = { n: number };
type A = { type: 'INC' };

function makeStore (initial: S = { n: 0 }) {
  return createStore<S, A>((state = initial, action) => {
    if (action.type === 'INC') {
      return { n: state.n + 1 };
    }
    return state;
  }, initial);
}

describe('createStore destroy mid-notify', () => {
  test('later state$ subscriber still receives the emission that triggered destroy', () => {
    const store = makeStore();
    const seen: string[] = [];

    store.state$.subscribe({
      next: (s) => {
        seen.push(`A:${s.n}`);
        if (s.n === 1) {
          store.destroy();
        }
      },
    });
    store.state$.subscribe({
      next: (s) => {
        seen.push(`B:${s.n}`);
      },
      complete: () => {
        seen.push('B:complete');
      },
    });

    store.dispatch({ type: 'INC' });

    expect(seen).toEqual(['A:0', 'B:0', 'A:1', 'B:1', 'B:complete']);
  });

  test('connect sibling: destroy in earlier onUpdate still delivers mapped props to later connect', async () => {
    const store = makeStore();

    class Killer extends Component<{ n?: number }, Record<string, never>> {
      public override onUpdate (): void {
        if ((this.props.n ?? 0) >= 1) {
          store.destroy();
        }
      }
    }

    class Victim extends Component<{ n?: number }, Record<string, never>> {}

    const ConnectedKiller = connect(store, (s: S) => ({ n: s.n }))(Killer);
    const ConnectedVictim = connect(store, (s: S) => ({ n: s.n }))(Victim);

    const killer = new ConnectedKiller({});
    const victim = new ConnectedVictim({});
    void killer.onMount!();
    void victim.onMount!();
    await Promise.resolve();
    await Promise.resolve();

    store.dispatch({ type: 'INC' });

    expect(killer.props.n).toBe(1);
    expect(victim.props.n).toBe(1);
  });

  test('destroy outside notify still completes immediately', () => {
    const store = makeStore();
    let completed = false;
    store.state$.subscribe({
      next: () => undefined,
      complete: () => {
        completed = true;
      },
    });
    store.destroy();
    expect(completed).toBe(true);
    expect(() => store.dispatch({ type: 'INC' })).toThrow(/destroyed/);
  });
});

// silence unused if tree-shaken
void (0 as unknown as DispatchMethod<A>);
