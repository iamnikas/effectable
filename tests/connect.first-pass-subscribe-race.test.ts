/**
 * First-pass subscribe assign race: BehaviorSubject emits synchronously inside
 * `subscribe()`, so super.onMount/onUnmount can run before `__connectSubscription`
 * is assigned. disposeConnectSubscription no-ops; the post-subscribe assignment
 * then keeps a zombie sub or clobbers a nested remount's newer subscription.
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

type ConnectedInternals = {
  __connectSubscription: { closed?: boolean; unsubscribe: () => void } | null;
  __connectTornDown: boolean;
  __connectMountCompleted: boolean;
  __connectMountGeneration: number;
};

describe('connect first-pass subscribe assign race', () => {
  test('abort mount via onUnmount during first pass must not leave a live subscription', () => {
    const store = makeStore();
    let mapCalls = 0;

    class C extends Component<{ n?: number }, Record<string, never>> {
      public override onMount (): void {
        this.onUnmount!();
      }
    }

    const Connected = connect(
      store,
      (s: S) => {
        mapCalls += 1;
        return { n: s.n };
      },
    )(C);

    const inst = new Connected({}) as C & ConnectedInternals;
    void inst.onMount!();

    expect(inst.__connectTornDown).toBe(true);
    expect(inst.__connectMountCompleted).toBe(false);
    expect(inst.__connectSubscription).toBeNull();

    const propsAfterMount = { ...inst.props };
    mapCalls = 0;
    store.dispatch({ type: 'INC' });

    expect(mapCalls).toBe(0);
    expect(inst.props).toEqual(propsAfterMount);
  });

  test('nested remount during first pass must not double-subscribe or leak the inner sub', () => {
    const store = makeStore();
    let mapCalls = 0;
    let nested = false;
    let updates = 0;

    class C extends Component<{ n?: number }, Record<string, never>> {
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

    const Connected = connect(
      store,
      (s: S) => {
        mapCalls += 1;
        return { n: s.n };
      },
    )(C);

    const inst = new Connected({}) as C & ConnectedInternals;
    void inst.onMount!();

    expect(inst.__connectTornDown).toBe(false);
    expect(inst.__connectMountCompleted).toBe(true);
    expect(inst.__connectMountGeneration).toBe(2);
    expect(inst.__connectSubscription).not.toBeNull();

    mapCalls = 0;
    updates = 0;
    store.dispatch({ type: 'INC' });
    expect(mapCalls).toBe(1);
    expect(updates).toBe(1);
    expect(inst.props.n).toBe(1);

    void inst.onUnmount!();
    expect(inst.__connectSubscription).toBeNull();

    mapCalls = 0;
    store.dispatch({ type: 'INC' });
    expect(mapCalls).toBe(0);
  });
});
