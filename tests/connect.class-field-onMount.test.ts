/**
 * Regression: class-field `onMount` / `onUnmount` must not shadow connect wiring.
 *
 * Arrow / class-field lifecycle hooks are own instance properties. Without capturing
 * them in the Connected constructor, GraphRuntime invokes the user field directly and
 * never runs connect's subscribe / mapState / teardown.
 *
 * Subclass class fields initialize *after* `super()` returns and overwrite the
 * Connected constructor reinstall (fields use [[DefineOwnProperty]], not [[Set]]).
 * GraphRuntime must rebind after full `new`.
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';

describe('connect class-field lifecycle shadowing', () => {
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

  it('class-field onMount sees mapped state and store updates flow', async () => {
    const store = makeStore();
    const calls: string[] = [];

    class Svc extends Component<Record<string, never>, { n?: number }> {
      public override onMount = (): void => {
        calls.push(`mount:n=${String(this.props.n)}`);
      };

      public override onUnmount = (): void => {
        calls.push('unmount');
      };
    }

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Svc);
    const rt = await GraphRuntime.mount(h(Connected, {}));
    const inst = rt.getRootInstance() as InstanceType<typeof Connected>;

    expect(calls).toEqual(['mount:n=0']);
    expect(inst.props.n).toBe(0);

    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    expect(inst.props.n).toBe(1);

    await rt.unmount();
    expect(calls).toEqual(['mount:n=0', 'unmount']);
  });

  it('prototype onMount still works (no class-field)', async () => {
    const store = makeStore();
    const calls: string[] = [];

    class Svc extends Component<Record<string, never>, { n?: number }> {
      public override onMount (): void {
        calls.push(`mount:n=${String(this.props.n)}`);
      }

      public override onUnmount (): void {
        calls.push('unmount');
      }
    }

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Svc);
    const rt = await GraphRuntime.mount(h(Connected, {}));
    expect(calls).toEqual(['mount:n=0']);
    await rt.unmount();
    expect(calls).toEqual(['mount:n=0', 'unmount']);
  });

  it('subclass class-field onMount still gets mapped state and store updates', async () => {
    const store = makeStore();
    const calls: string[] = [];

    class Svc extends Component<Record<string, never>, { n?: number }> {}
    const Connected = connect(store, (s: S) => ({ n: s.n }))(Svc);

    class Ext extends Connected {
      public override onMount = (): void => {
        calls.push(`mount:n=${String(this.props.n)}`);
      };
    }

    const rt = await GraphRuntime.mount(h(Ext, {}));
    const inst = rt.getRootInstance() as InstanceType<typeof Ext>;

    expect(calls).toEqual(['mount:n=0']);
    expect(inst.props.n).toBe(0);

    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    expect(inst.props.n).toBe(1);

    await rt.unmount();
  });

  it('subclass class-field onUnmount still tears down the store subscription', async () => {
    const store = makeStore();
    let mapCalls = 0;

    class Svc extends Component<Record<string, never>, { n?: number }> {}
    const Connected = connect(store, (s: S) => {
      mapCalls += 1;
      return { n: s.n };
    })(Svc);

    class Ext extends Connected {
      public override onUnmount = (): void => {
        // user teardown only — must not prevent connect unsubscribe
      };
    }

    const rt = await GraphRuntime.mount(h(Ext, {}));
    expect(mapCalls).toBeGreaterThanOrEqual(1);

    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    const callsAfterDispatch = mapCalls;
    expect(callsAfterDispatch).toBeGreaterThan(1);

    await rt.unmount();

    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    expect(mapCalls).toBe(callsAfterDispatch);
  });
});
