/**
 * mapState almost always allocates a fresh object. Without shallow-equal on the
 * mapped record, every store emission looks like a props change → setState →
 * onUpdate. An onUpdate that dispatches then infinite-loops even when mapped
 * fields are unchanged (including stable NaN via Object.is).
 *
 * Distinct from own-props NaN gates (#134/#138/#147) and select-level NaN
 * distinctUntilChanged (#150/#151): this is applyMappedStateProps on object results.
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';

describe('connect mapped-state shallow equality', () => {
  type S = { score: number; n: number };
  type A = { type: 'BUMP' } | { type: 'SET_SCORE'; payload: number };

  function makeStore (score: number) {
    return createStore<S, A>((state, action) => {
      const current = state ?? { score, n: 0 };
      if (action.type === 'BUMP') {
        return { ...current, n: current.n + 1 };
      }
      if (action.type === 'SET_SCORE') {
        return { ...current, score: action.payload };
      }
      return current;
    }, { score, n: 0 });
  }

  it('stable mapped values must not loop when onUpdate dispatches unrelated actions', async () => {
    const store = makeStore(1);
    let updates = 0;

    class Host extends Component<object, { score?: number }> {
      public override onUpdate (): void {
        updates += 1;
        if (updates < 50) {
          store.dispatch({ type: 'BUMP' });
        }
      }

      public override compose () {
        return [];
      }
    }

    const Connected = connect(store, (s: S) => ({ score: s.score }))(Host);
    const runtime = await GraphRuntime.mount(h(Connected, {}));

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 80);
    });

    expect(runtime.getState()).toBe('active');
    // Post-mount kickoff may deliver one onUpdate; a shallow gate must stop the
    // dispatch→select→onUpdate spiral well below the 50-dispatch ceiling.
    expect(updates).toBeLessThan(10);
    await runtime.unmount();
  });

  it('stable NaN mapped fields must not loop when onUpdate dispatches', async () => {
    const store = makeStore(Number.NaN);
    let updates = 0;

    class Host extends Component<object, { score?: number }> {
      public override onUpdate (): void {
        updates += 1;
        if (updates < 50) {
          store.dispatch({ type: 'BUMP' });
        }
      }

      public override compose () {
        return [];
      }
    }

    const Connected = connect(store, (s: S) => ({ score: s.score }))(Host);
    const runtime = await GraphRuntime.mount(h(Connected, {}));

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 80);
    });

    expect(runtime.getState()).toBe('active');
    expect(updates).toBeLessThan(10);
    await runtime.unmount();
  });

  it('actual mapped-value changes still deliver onUpdate', async () => {
    const store = makeStore(0);
    let updates = 0;
    let lastScore = -1;

    class Host extends Component<object, { score?: number }> {
      public override onUpdate (): void {
        updates += 1;
        lastScore = (this.props as { score?: number }).score ?? -1;
        if (updates < 5) {
          store.dispatch({ type: 'SET_SCORE', payload: updates });
        }
      }

      public override compose () {
        return [];
      }
    }

    const Connected = connect(store, (s: S) => ({ score: s.score }))(Host);
    const runtime = await GraphRuntime.mount(h(Connected, {}));

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 80);
    });

    expect(runtime.getState()).toBe('active');
    expect(updates).toBeGreaterThanOrEqual(5);
    expect(lastScore).toBeGreaterThanOrEqual(4);
    await runtime.unmount();
  });
});
