/**
 * Reproduction: async super.onMount still pending across onUnmount → onMount remount.
 * Old mount promise must not completeConnectMount / finishDispatchOnlyMount for the new generation.
 */
import { Component, connect, createStore } from 'Effectable';
import type { DispatchMethod } from 'Effectable';

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

describe('connect async remount race', () => {
  test('mapDispatch-only: stale async onMount must not complete while remount still pending', async () => {
    const store = makeStore();
    const events: string[] = [];
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    let mountCalls = 0;

    class C extends Component<{ inc?: () => void }, Record<string, never>> {
      public override onMount (): Promise<void> {
        mountCalls += 1;
        const call = mountCalls;
        events.push(`mount-start:${call}`);
        return new Promise<void>((resolve) => {
          const finish = (): void => {
            events.push(`mount-resolve:${call}`);
            resolve();
          };
          if (call === 1) {
            resolveFirst = finish;
          } else {
            resolveSecond = finish;
          }
        });
      }

      public override onUpdate (): void {
        events.push('onUpdate');
      }
    }

    const Connected = connect(
      store,
      null,
      (dispatch: DispatchMethod<A>) => ({ inc: () => dispatch({ type: 'INC' }) }),
    )(C);

    const inst = new Connected({});
    const p1 = inst.onMount!();
    expect(p1).toBeInstanceOf(Promise);

    void inst.onUnmount!();
    const p2 = inst.onMount!();

    // Stale first mount resolves while second onMount is still pending.
    resolveFirst();
    await p1.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    // BUG: stale completion marks mount complete and delivers onUpdate before remount finishes.
    expect(events).toEqual([
      'mount-start:1',
      'mount-start:2',
      'mount-resolve:1',
    ]);
    expect(events).not.toContain('onUpdate');

    resolveSecond();
    await p2;
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual([
      'mount-start:1',
      'mount-start:2',
      'mount-resolve:1',
      'mount-resolve:2',
      'onUpdate',
    ]);
  });

  test('mapState: stale async onMount must not completeConnectMount while remount still pending', async () => {
    const store = makeStore();
    const events: string[] = [];
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    let mountCalls = 0;

    class C extends Component<{ v?: number }, Record<string, never>> {
      public override onMount (): Promise<void> {
        mountCalls += 1;
        const call = mountCalls;
        events.push(`mount-start:${call}`);
        return new Promise<void>((resolve) => {
          const finish = (): void => {
            events.push(`mount-resolve:${call}`);
            resolve();
          };
          if (call === 1) {
            resolveFirst = finish;
          } else {
            resolveSecond = finish;
          }
        });
      }

      public override onUpdate (): void {
        events.push(`onUpdate:v=${this.props.v}`);
      }
    }

    const Connected = connect(
      store,
      (s: S) => ({ v: s.n }),
    )(C);

    const inst = new Connected({});
    const p1 = inst.onMount!();
    expect(p1).toBeInstanceOf(Promise);

    void inst.onUnmount!();
    const p2 = inst.onMount!();

    resolveFirst();
    await p1.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual([
      'mount-start:1',
      'mount-start:2',
      'mount-resolve:1',
    ]);
    expect(events.filter((e) => e.startsWith('onUpdate'))).toEqual([]);

    // Store emit during incomplete remount must defer, not deliver onUpdate.
    store.dispatch({ type: 'INC' });
    expect(events.filter((e) => e.startsWith('onUpdate'))).toEqual([]);

    resolveSecond();
    await p2;
    await Promise.resolve();
    await Promise.resolve();

    expect(inst.props.v).toBe(1);
    expect(events.filter((e) => e.startsWith('onUpdate'))).toEqual([
      'onUpdate:v=1',
    ]);
  });
});
