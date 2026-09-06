/**
 * Critical: first-pass connect used to call user onMount inside store.select().subscribe() next.
 * A nested dispatch that makes mapStateToProps throw was a reentrant observer error (RxJS
 * reportUnhandledError / process crash) and, for async onMount, orphaned pendingMountResult
 * (unhandled rejection) when onMount threw syncSubscribeError without returning that Promise.
 */
import { Component, connect, createStore } from 'Effectable';

type S = { n: number; blow: boolean };
type A = { type: 'BLOW' };

function makeStore (initial: S = { n: 0, blow: false }) {
  return createStore<S, A>((state = initial, action) => {
    if (action.type === 'BLOW') {
      return { ...state, blow: true };
    }
    return state;
  }, initial);
}

describe('connect nested mapState throw during first-pass onMount', () => {
  test('sync onMount: fails onMount cleanly — not uncaughtException', () => {
    const store = makeStore();
    const uncaught: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      uncaught.push(err);
    };
    process.on('uncaughtException', onUncaught);

    class C extends Component<{ v?: number }, Record<string, never>> {
      public override onMount (): void {
        store.dispatch({ type: 'BLOW' });
      }
    }

    const Connected = connect(
      store,
      (state: S) => {
        if (state.blow) {
          throw new Error('mapState blow');
        }
        return { v: state.n };
      },
    )(C);

    let thrown: unknown = null;
    try {
      new Connected({}).onMount();
    } catch (err: unknown) {
      thrown = err;
    }

    process.off('uncaughtException', onUncaught);

    expect(uncaught).toEqual([]);
    expect(thrown).toEqual(expect.objectContaining({ message: 'mapState blow' }));
  });

  test('async onMount: no unhandledRejection / uncaughtException; mount rejects or throws', async () => {
    const store = makeStore();
    const uncaught: unknown[] = [];
    const unhandled: unknown[] = [];
    const onUncaught = (err: unknown): void => {
      uncaught.push(err);
    };
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err);
    };
    process.on('uncaughtException', onUncaught);
    process.on('unhandledRejection', onUnhandled);

    let resolveMount!: () => void;

    class C extends Component<{ v?: number }, Record<string, never>> {
      public override onMount (): Promise<void> {
        store.dispatch({ type: 'BLOW' });
        return new Promise<void>((resolve) => {
          resolveMount = resolve;
        });
      }
    }

    const Connected = connect(
      store,
      (state: S) => {
        if (state.blow) {
          throw new Error('mapState blow');
        }
        return { v: state.n };
      },
    )(C);

    let syncThrow: unknown = null;
    let asyncReject: unknown = null;
    try {
      const result = new Connected({}).onMount();
      if (result !== undefined && typeof (result as Promise<void>).then === 'function') {
        await (result as Promise<void>).then(
          () => {
            throw new Error('expected mount promise to reject');
          },
          (err: unknown) => {
            asyncReject = err;
          },
        );
      }
    } catch (err: unknown) {
      syncThrow = err;
    }

    if (typeof resolveMount === 'function') {
      resolveMount();
    }
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    process.off('uncaughtException', onUncaught);
    process.off('unhandledRejection', onUnhandled);

    expect(uncaught).toEqual([]);
    expect(unhandled).toEqual([]);
    const failure = syncThrow ?? asyncReject;
    expect(failure).toEqual(expect.objectContaining({ message: 'mapState blow' }));
  });
});
