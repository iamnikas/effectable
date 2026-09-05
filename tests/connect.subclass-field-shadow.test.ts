/**
 * Regression: class-field lifecycle on a *subclass of Connected* must not bypass connect.
 *
 * PR #74 captures BaseCtor class fields inside Connected's constructor. Subclass-of-Connected
 * class fields initialize *after* that constructor and overwrite the own onMount/onUnmount
 * wiring again — leaving mapped props undefined and/or leaking the store subscription.
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';

describe('connect subclass-of-Connected class-field lifecycle shadowing', () => {
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

  it('subclass class-field onMount sees mapped state and store updates flow', async () => {
    const store = makeStore();
    const calls: string[] = [];

    class Svc extends Component<Record<string, never>, { n?: number }> {}

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Svc);

    class Ext extends Connected {
      public override onMount = (): void => {
        calls.push(`ext-mount:n=${String(this.props.n)}`);
      };
    }

    const rt = await GraphRuntime.mount(h(Ext, {}));
    const inst = rt.getRootInstance() as InstanceType<typeof Ext>;

    expect(calls).toEqual(['ext-mount:n=0']);
    expect(inst.props.n).toBe(0);

    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    expect(inst.props.n).toBe(1);

    await rt.unmount();
  });

  it('subclass class-field onUnmount alone still disposes the store subscription', async () => {
    const store = makeStore();
    let updateCount = 0;

    class Svc extends Component<Record<string, never>, { n?: number }> {
      public override onUpdate (): void {
        updateCount += 1;
      }
    }

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Svc);

    class Ext extends Connected {
      public override onUnmount = (): void => {
        // Subclass field only — must not prevent connect teardown.
      };
    }

    const rt = await GraphRuntime.mount(h(Ext, {}));
    // Allow post-mount kick-off microtask (may deliver one onUpdate).
    await Promise.resolve();
    await Promise.resolve();

    const before = updateCount;
    await rt.unmount();

    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    await Promise.resolve();

    expect(updateCount).toBe(before);
  });
});
