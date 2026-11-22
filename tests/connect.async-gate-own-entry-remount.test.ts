/**
 * Regression (#118 / #160 residual after #163): own-entry remount during an
 * async user `onMount` must not drop the outer Promise.
 *
 * Nested remount advances `__connectMountGeneration`. If the outer
 * `runConnectOnMount` then returns sync on mismatch, `enterConnectOnMount`
 * never claims `__connectMountAsyncInFlight` for the orphaned user Promise,
 * so a later `await super.onMount()` re-enters wiring after the nested remount
 * settles (extra user onMount / subscribe cycles; GraphRuntime resolves early).
 */
import {
  Component,
  connect,
  createStore,
} from 'Effectable';

describe('connect #160 residual: own-entry remount keeps async mount Promise', () => {
  interface S { n: number }
  type A = { type: 'INC' };

  function makeStore () {
    return createStore<S, A>(
      (s, a) => (a.type === 'INC' ? { n: s.n + 1 } : s),
      { n: 0 }
    );
  }

  it('own-entry remount in sync prelude: await super.onMount must not reenter', async () => {
    const store = makeStore();
    let userMountEntries = 0;
    let releaseOuter!: () => void;
    const outerHeld = new Promise<void>((r) => { releaseOuter = r; });
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
          // Own-entry remount in sync prelude (before first await).
          void this.onMount!();
          await outerHeld;
        } else {
          await Promise.resolve();
        }
        await super.onMount?.();
      }
    }

    const inst = new Ext({});
    const result = inst.onMount!();
    const isPromise = result != null && typeof (result as Promise<void>).then === 'function';

    // Let nested remount settle fully while the outer hook is still held.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    releaseOuter();
    expect(isPromise).toBe(true);
    await (result as Promise<void>);
    await Promise.resolve();
    await Promise.resolve();

    expect(userMountEntries).toBe(2);
  });

  it('await this.onMount() remount: outer still returns Promise and does not reenter', async () => {
    const store = makeStore();
    let userMountEntries = 0;
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
          await this.onMount!();
        } else {
          await Promise.resolve();
        }
        await super.onMount?.();
      }
    }

    const inst = new Ext({});
    const result = inst.onMount!();
    expect(result != null && typeof (result as Promise<void>).then === 'function').toBe(true);
    await (result as Promise<void>);
    await Promise.resolve();
    await Promise.resolve();

    expect(userMountEntries).toBe(2);
  });
});
