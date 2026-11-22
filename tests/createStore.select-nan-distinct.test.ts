/**
 * Regression: `select()` used `distinctUntilChanged()` with default `===`.
 * `NaN !== NaN`, so a stable NaN selector result re-emitted on every dispatch.
 * A subscriber that dispatched from that notification could infinite-loop / OOM.
 */

import { createStore } from '../src/store/createStore';

type NanState = { v: number };
type NanAction = { type: 'NOP' } | { type: 'SET'; payload: number };

function nanReducer (state: NanState = { v: NaN }, action: NanAction): NanState {
  if (action.type === 'SET') {
    return { v: action.payload };
  }
  return state;
}

describe('createStore.select NaN distinctUntilChanged', () => {
  it('stable NaN does not re-emit when a subscriber dispatches', () => {
    const store = createStore<NanState, NanAction>(nanReducer, { v: NaN });
    let ticks = 0;

    const sub = store.select((s) => s.v).subscribe(() => {
      ticks += 1;
      if (ticks > 20) {
        throw new Error('select NaN re-entered via distinctUntilChanged(===)');
      }
      store.dispatch({ type: 'NOP' });
    });

    expect(() => store.dispatch({ type: 'NOP' })).not.toThrow();
    // Initial BehaviorSubject emission only — NOP must not re-notify for NaN.
    expect(ticks).toBe(1);

    sub.unsubscribe();
    store.destroy();
  });

  it('still emits when the selector result actually changes', () => {
    const store = createStore<NanState, NanAction>(nanReducer, { v: 1 });
    const values: number[] = [];

    const sub = store.select((s) => s.v).subscribe((v) => {
      values.push(v);
    });

    store.dispatch({ type: 'SET', payload: 2 });
    store.dispatch({ type: 'SET', payload: NaN });
    store.dispatch({ type: 'NOP' });
    store.dispatch({ type: 'SET', payload: 3 });

    expect(values).toEqual([1, 2, NaN, 3]);

    sub.unsubscribe();
    store.destroy();
  });
});
