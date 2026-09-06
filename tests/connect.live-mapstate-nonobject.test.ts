/**
 * Live (post-mount) mapState object→non-object must clear stale __connectStateProps.
 * Remount-only clearing (#66) left the same hole on an active subscription: applyMappedStateProps
 * no-op'd on null/array/primitive while deliverConnectUpdate still ran with stuck keys.
 */
import { Component, connect, createStore } from 'Effectable';

type S = { n: number; mode: 'obj' | 'null' | 'arr' | 'prim' };
type A =
  | { type: 'TO_NULL' }
  | { type: 'TO_ARR' }
  | { type: 'TO_PRIM' }
  | { type: 'TO_OBJ' }
  | { type: 'INC' };

function makeStore (initial: S = { n: 1, mode: 'obj' }) {
  return createStore<S, A>((state = initial, action) => {
    if (action.type === 'TO_NULL') {
      return { ...state, mode: 'null' };
    }
    if (action.type === 'TO_ARR') {
      return { ...state, mode: 'arr' };
    }
    if (action.type === 'TO_PRIM') {
      return { ...state, mode: 'prim' };
    }
    if (action.type === 'TO_OBJ') {
      return { ...state, mode: 'obj', n: state.n + 1 };
    }
    if (action.type === 'INC') {
      return { ...state, n: state.n + 1 };
    }
    return state;
  }, initial);
}

function mapState (s: S): { v: number } {
  if (s.mode === 'null') {
    return null as unknown as { v: number };
  }
  if (s.mode === 'arr') {
    return [s.n] as unknown as { v: number };
  }
  if (s.mode === 'prim') {
    return s.n as unknown as { v: number };
  }
  return { v: s.n };
}

describe('connect live mapState non-object clears stale state props', () => {
  test('object→null drops previous mapped keys and delivers onUpdate with cleared props', async () => {
    const store = makeStore();
    const seen: Array<number | undefined> = [];

    class C extends Component<{ v?: number }, Record<string, never>> {
      override onUpdate (): void {
        seen.push(this.props.v);
      }
    }

    const Connected = connect(store, mapState)(C);
    const inst = new Connected({});
    void inst.onMount!();
    expect(inst.props.v).toBe(1);

    // Drain post-mount kick-off onUpdate.
    await Promise.resolve();
    const kickoffLen = seen.length;
    expect(kickoffLen).toBeGreaterThanOrEqual(1);

    store.dispatch({ type: 'TO_NULL' });
    expect(inst.props.v).toBeUndefined();
    expect(seen.slice(kickoffLen)).toEqual([undefined]);
  });

  test('object→array and object→primitive also clear stale keys', () => {
    const store = makeStore();

    class C extends Component<{ v?: number }, Record<string, never>> {}

    const Connected = connect(store, mapState)(C);
    const inst = new Connected({});
    void inst.onMount!();
    expect(inst.props.v).toBe(1);

    store.dispatch({ type: 'TO_ARR' });
    expect(inst.props.v).toBeUndefined();

    store.dispatch({ type: 'TO_OBJ' });
    expect(inst.props.v).toBe(2);

    store.dispatch({ type: 'TO_PRIM' });
    expect(inst.props.v).toBeUndefined();
  });

  test('returning a valid object after a clear still refreshes state props', () => {
    const store = makeStore();

    class C extends Component<{ v?: number }, Record<string, never>> {}

    const Connected = connect(store, mapState)(C);
    const inst = new Connected({});
    void inst.onMount!();
    expect(inst.props.v).toBe(1);

    store.dispatch({ type: 'TO_NULL' });
    expect(inst.props.v).toBeUndefined();

    store.dispatch({ type: 'TO_OBJ' });
    expect(inst.props.v).toBe(2);
  });
});
