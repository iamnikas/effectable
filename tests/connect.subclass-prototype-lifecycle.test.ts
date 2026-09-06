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
        super.onMount?.();
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

  it('subclass this.onMount() remount during user hook must resubscribe', () => {
    const store = makeStore();
    const updates: number[] = [];
    let nested = false;
    let selectorRuns = 0;

    class Svc extends Component<Record<string, never>, { n?: number }> {
      public override onUpdate (): void {
        updates.push(this.props.n as number);
      }
    }

    const Connected = connect(store, (s: S) => {
      selectorRuns += 1;
      return { n: s.n };
    })(Svc);

    class Ext extends Connected {
      public override onMount (): void {
        // super.onMount must stay a no-op; this.onMount must still remount.
        super.onMount?.();
        if (!nested) {
          nested = true;
          void this.onUnmount?.();
          void this.onMount?.();
        }
      }
    }

    const inst = new Ext({});
    inst.onMount();

    const before = selectorRuns;
    store.dispatch({ type: 'INC' });

    expect(updates).toEqual([1]);
    expect(selectorRuns - before).toBe(1);
    void inst.onUnmount?.();
  });

  it('subclass prototype onMount wins over wrapped base class-field capture', async () => {
    const store = makeStore();
    const calls: string[] = [];

    class Base extends Component<Record<string, never>, { n?: number }> {
      public override onMount = (): void => {
        calls.push('base-field');
      };
    }

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Base);

    class Ext extends Connected {
      // Base class-field makes Connected's inherited type a property; this method is the
      // intentional runtime shape under test (TS2425 property vs method).
      // @ts-expect-error TS2425 — prototype override vs wrapped base class-field
      public override onMount (): void {
        calls.push(`ext:n=${String(this.props.n)}`);
      }
    }

    const rt = await GraphRuntime.mount(h(Ext, {}));
    expect(calls).toEqual(['ext:n=0']);
    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    expect((rt.getRootInstance() as InstanceType<typeof Ext>).props.n).toBe(1);
    await rt.unmount();
  });

  it('subclass prototype onUnmount wins over wrapped base class-field capture', async () => {
    const store = makeStore();
    const calls: string[] = [];

    class Base extends Component<Record<string, never>, { n?: number }> {
      public override onUnmount = (): void => {
        calls.push('base-unmount-field');
      };
    }

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Base);

    class Ext extends Connected {
      // @ts-expect-error TS2425 — prototype override vs wrapped base class-field
      public override onUnmount (): void {
        calls.push('ext-unmount');
      }
    }

    const rt = await GraphRuntime.mount(h(Ext, {}));
    await rt.unmount();
    expect(calls).toEqual(['ext-unmount']);
  });

  it('wrapped base class-field still runs when Connected is not subclassed', async () => {
    const store = makeStore();
    const calls: string[] = [];

    class Base extends Component<Record<string, never>, { n?: number }> {
      public override onMount = (): void => {
        calls.push(`base-field:n=${String(this.props.n)}`);
      };
    }

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Base);
    const rt = await GraphRuntime.mount(h(Connected, {}));
    expect(calls).toEqual(['base-field:n=0']);
    await rt.unmount();
  });

  it('subclass class-field beats intermediate Connected-subclass prototype onMount', async () => {
    const store = makeStore();
    const calls: string[] = [];

    class Base extends Component<Record<string, never>, { n?: number }> {
      public override onMount = (): void => {
        calls.push('base-field');
      };
    }

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Base);

    class Mid extends Connected {
      // @ts-expect-error TS2425 — prototype override vs wrapped base class-field
      public override onMount (): void {
        calls.push('mid-proto');
      }
    }

    class Ext extends Mid {
      public override onMount = (): void => {
        calls.push(`ext-field:n=${String(this.props.n)}`);
      };
    }

    const rt = await GraphRuntime.mount(h(Ext, {}));
    expect(calls).toEqual(['ext-field:n=0']);
    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    expect((rt.getRootInstance() as InstanceType<typeof Ext>).props.n).toBe(1);
    await rt.unmount();
  });

  it('subclass class-field beats intermediate Connected-subclass prototype onUnmount', async () => {
    const store = makeStore();
    const calls: string[] = [];

    class Base extends Component<Record<string, never>, { n?: number }> {
      public override onUnmount = (): void => {
        calls.push('base-unmount-field');
      };
    }

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Base);

    class Mid extends Connected {
      // @ts-expect-error TS2425 — prototype override vs wrapped base class-field
      public override onUnmount (): void {
        calls.push('mid-unmount-proto');
      }
    }

    class Ext extends Mid {
      public override onUnmount = (): void => {
        calls.push('ext-unmount-field');
      };
    }

    const rt = await GraphRuntime.mount(h(Ext, {}));
    await rt.unmount();
    expect(calls).toEqual(['ext-unmount-field']);
  });
});
