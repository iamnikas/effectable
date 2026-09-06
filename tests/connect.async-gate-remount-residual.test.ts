/**
 * Regression (#118 residual): async subclass `await super.onMount()` /
 * `await super.onUnmount()` must stay gated across remount.
 *
 * Mount hole: sync remount zeroes `__connectMountAsyncGateGen` and advances
 * `__connectMountGeneration`, so generation-equality no longer blocks a stale
 * `await super.onMount()` → re-enters wiring (extra user onMount + dispose/resubscribe).
 *
 * Unmount hole: boolean `__connectUnmountAsyncGate` is cleared unconditionally in
 * `finally`, so a stale unmount settling before a newer `await super.onUnmount()`
 * re-enters teardown.
 */
import {
  Component,
  connect,
  createStore,
} from 'Effectable';

describe('connect #118 residual: async gates vs remount', () => {
  interface S { n: number }
  type A = { type: 'INC' };

  function makeStore () {
    return createStore<S, A>(
      (s, a) => (a.type === 'INC' ? { n: s.n + 1 } : s),
      { n: 0 }
    );
  }

  it('stale await super.onMount after unmount+remount must not reenter user onMount', async () => {
    const store = makeStore();
    let userMountEntries = 0;
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((r) => { releaseFirst = r; });
    let pass = 0;

    class Svc extends Component<Record<string, never>, { n?: number }> {}
    const Connected = connect(store, (s: S) => ({ n: s.n }))(Svc);

    class Ext extends Connected {
      public override async onMount (): Promise<void> {
        userMountEntries += 1;
        const which = ++pass;
        if (userMountEntries > 8) {
          throw new Error(`onMount reentered ${userMountEntries}`);
        }
        if (which === 1) {
          await firstHeld;
        } else {
          await Promise.resolve();
        }
        await super.onMount?.();
      }
    }

    const inst = new Ext({});
    const p1 = inst.onMount!();
    void inst.onUnmount!();
    await inst.onMount!();

    releaseFirst();
    await p1.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(userMountEntries).toBe(2);
  });

  it('stale await super.onUnmount finally must not clear gate for newer unmount', async () => {
    const store = makeStore();
    let userUnmountEntries = 0;
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    let ordinal = 0;

    class Svc extends Component<Record<string, never>, { n?: number }> {}
    const Connected = connect(store, (s: S) => ({ n: s.n }))(Svc);

    class Ext extends Connected {
      public override async onUnmount (): Promise<void> {
        userUnmountEntries += 1;
        const o = ++ordinal;
        if (userUnmountEntries > 8) {
          throw new Error(`onUnmount reentered ${userUnmountEntries}`);
        }
        if (o === 1) await new Promise<void>((r) => { resolveFirst = r; });
        else if (o === 2) await new Promise<void>((r) => { resolveSecond = r; });
        else await Promise.resolve();
        await super.onUnmount?.();
      }
    }

    const inst = new Ext({});
    await inst.onMount!();
    const p1 = inst.onUnmount!();
    await inst.onMount!();
    const p2 = inst.onUnmount!();

    resolveFirst();
    await p1;
    resolveSecond();
    await p2;

    expect(userUnmountEntries).toBe(2);
  });
});
