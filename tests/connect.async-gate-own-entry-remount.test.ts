/**
 * Regression (#118 residual): own-entry remount under an in-flight async subclass
 * onMount must not clear `__connectMountAsyncGateGen`.
 *
 * After #118, sync `__connectMountReentry` is cleared when Connected.onMount returns a
 * Promise. The async generation gate covers `await …; await super.onMount()`. But when
 * the user also does own-entry `this.onMount()` remount in the sync prelude:
 *   1. Nested remount bumps generation and installs the async gate.
 *   2. Outer `runConnectOnMount` sees generation mismatch and used to return sync
 *      (dropping the user Promise).
 *   3. Outer `enterConnectOnMount.finally` cleared the nested gate on that sync return.
 *   4. Outer `await super.onMount()` then re-entered wiring (extra user onMount /
 *      subscribe cycles; GraphRuntime.mount could resolve while remount still held).
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';

describe('connect async gate × own-entry remount', () => {
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

  it('void this.onMount() then await super.onMount must not illicitly re-enter', async () => {
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
        // Own-entry remount once during the sync prelude (before first await).
        if (userMountEntries === 1) {
          void this.onMount!();
        }
        await Promise.resolve();
        await super.onMount?.();
      }
    }

    const rt = await GraphRuntime.mount(h(Ext, {}));
    expect(userMountEntries).toBe(2);

    const before = updates.length;
    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    await Promise.resolve();
    // Single live subscription → one update (not doubled / unbounded).
    expect(updates.length - before).toBe(1);

    await rt.unmount();
  });

  it('await this.onMount() remount returns a Promise and runs user hook twice', async () => {
    const store = makeStore();
    let userMountEntries = 0;

    class Svc extends Component<Record<string, never>, { n?: number }> {}
    const Connected = connect(store, (s: S) => ({ n: s.n }))(Svc);

    class Ext extends Connected {
      private remounted = false;
      public override async onMount (): Promise<void> {
        userMountEntries += 1;
        if (userMountEntries > 8) {
          throw new Error(`user onMount reentered ${userMountEntries} times`);
        }
        if (!this.remounted) {
          this.remounted = true;
          await this.onMount!();
        }
        await Promise.resolve();
        await super.onMount?.();
      }
    }

    const inst = new Ext({});
    const result = inst.onMount!();
    expect(result).toBeInstanceOf(Promise);
    await result;
    expect(userMountEntries).toBe(2);

    await inst.onUnmount!();
    await inst.onMount!();
    expect(userMountEntries).toBe(3);
  });

  it('GraphRuntime.mount stays pending while awaited remount is held', async () => {
    const store = makeStore();
    let userMountEntries = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const events: string[] = [];

    class Svc extends Component<Record<string, never>, { n?: number }> {
      public override onUpdate (): void {
        events.push('onUpdate');
      }
    }
    const Connected = connect(store, (s: S) => ({ n: s.n }))(Svc);

    class Ext extends Connected {
      private remounted = false;
      public override async onMount (): Promise<void> {
        userMountEntries += 1;
        if (userMountEntries > 8) {
          throw new Error(`user onMount reentered ${userMountEntries} times`);
        }
        if (!this.remounted) {
          this.remounted = true;
          await this.onMount!();
        } else {
          await held;
        }
        await Promise.resolve();
        await super.onMount?.();
      }
    }

    let resolved = false;
    const p = GraphRuntime.mount(h(Ext, {})).then((rt) => {
      resolved = true;
      return rt;
    });

    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(resolved).toBe(false);
    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    expect(events).toEqual([]);

    release();
    const rt = await p;
    expect(userMountEntries).toBe(2);
    await rt.unmount();
  });
});
