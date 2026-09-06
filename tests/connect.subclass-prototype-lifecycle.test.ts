/**
 * Regression: subclass-of-Connected that overrides onMount/onUnmount as
 * prototype methods must still run those hooks.
 *
 * Connected installs own onMount/onUnmount properties (class-field shadow fix).
 * Those shadow Ext.prototype forever for GraphRuntime entry; connect must still
 * delegate to Ext.prototype hooks after wiring, or user lifecycle is silently skipped
 * while store subscriptions keep running.
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';

describe('connect subclass-of-Connected prototype lifecycle', () => {
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

  it('prototype override onMount/onUnmount on Connected subclass must run', async () => {
    const store = makeStore();
    const calls: string[] = [];

    class Svc extends Component<Record<string, never>, { n?: number }> {}

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Svc);

    class Ext extends Connected {
      public override onMount (): void {
        calls.push(`mount:n=${String(this.props.n)}`);
      }

      public override onUnmount (): void {
        calls.push('unmount');
      }
    }

    const rt = await GraphRuntime.mount(h(Ext, {}));
    const inst = rt.getRootInstance() as InstanceType<typeof Ext>;

    expect(calls).toEqual(['mount:n=0']);
    expect(inst.props.n).toBe(0);

    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    expect(inst.props.n).toBe(1);

    await rt.unmount();
    expect(calls).toEqual(['mount:n=0', 'unmount']);
  });

  it('subclass super.onMount() during user hook must not double-subscribe', async () => {
    const store = makeStore();
    const calls: string[] = [];

    class Svc extends Component<Record<string, never>, { n?: number }> {}

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Svc);

    class Ext extends Connected {
      public override onMount (): void {
        // Natural subclass pattern: call super (Connected wiring). Must be a no-op
        // while wiring is already on the stack — otherwise double-subscribe.
        super.onMount();
        calls.push(`ext:n=${String(this.props.n)}`);
      }
    }

    const rt = await GraphRuntime.mount(h(Ext, {}));
    const inst = rt.getRootInstance() as InstanceType<typeof Ext>;

    expect(calls).toEqual(['ext:n=0']);
    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    // Single update — not doubled from a re-entrant subscribe.
    expect(inst.props.n).toBe(1);

    await rt.unmount();
  });
});
