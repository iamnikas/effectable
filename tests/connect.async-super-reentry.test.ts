/**
 * Regression: subclass-of-Connected async onMount/onUnmount that awaits then calls
 * `super.onMount()` / `super.onUnmount()` must not re-enter connect wiring.
 *
 * Sync reentry (`__connectMountReentry`) is cleared when Connected.onMount returns a
 * Promise — before the async user hook resumes. Without an async generation gate,
 * `await …; await super.onMount()` re-enters runConnectOnMount, re-invokes the user
 * hook, and infinite-subscribes (OOM).
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';

describe('connect async subclass super.onMount / onUnmount reentry', () => {
  interface S {
    n: number;
  }

  type A = { type: 'INC' };

  function makeStore () {
    return createStore<S, A>(
      (s, a) => (a.type === 'INC' ? { n: s.n + 1 } : s),
      { n: 0 }
    );
  }

  it('await then super.onMount must not infinite-reenter wiring', async () => {
    const store = makeStore();
    let userMountEntries = 0;
    const updates: number[] = [];

    class Svc extends Component<Record<string, never>, { n?: number }> {
      public override onUpdate (): void {
        updates.push(this.props.n ?? -1);
      }
    }

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Svc);

    class Ext extends Connected {
      public override async onMount (): Promise<void> {
        userMountEntries += 1;
        if (userMountEntries > 8) {
          throw new Error(`user onMount reentered ${userMountEntries} times`);
        }
        await Promise.resolve();
        // After await, sync reentry is cleared — must still be a no-op.
        await super.onMount?.();
      }
    }

    const rt = await GraphRuntime.mount(h(Ext, {}));
    expect(userMountEntries).toBe(1);

    const before = updates.length;
    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    await Promise.resolve();
    // Single subscription → one update (not doubled).
    expect(updates.length - before).toBe(1);

    await rt.unmount();
  });

  it('await super.onMount first still mounts once; same-instance remount after unmount works', async () => {
    const store = makeStore();
    let userMountEntries = 0;

    class Svc extends Component<Record<string, never>, { n?: number }> {}

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Svc);

    class Ext extends Connected {
      public override async onMount (): Promise<void> {
        userMountEntries += 1;
        await super.onMount?.();
      }
    }

    const inst = new Ext({});
    await inst.onMount!();
    expect(userMountEntries).toBe(1);

    await inst.onUnmount!();
    await inst.onMount!();
    expect(userMountEntries).toBe(2);
  });

  it('await then super.onUnmount must not re-run user teardown', async () => {
    const store = makeStore();
    let userUnmountEntries = 0;

    class Svc extends Component<Record<string, never>, { n?: number }> {}

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Svc);

    class Ext extends Connected {
      public override async onUnmount (): Promise<void> {
        userUnmountEntries += 1;
        if (userUnmountEntries > 8) {
          throw new Error(`user onUnmount reentered ${userUnmountEntries} times`);
        }
        await Promise.resolve();
        await super.onUnmount?.();
      }
    }

    const rt = await GraphRuntime.mount(h(Ext, {}));
    await rt.unmount();
    expect(userUnmountEntries).toBe(1);
  });
});
