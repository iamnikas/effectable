/**
 * Regression: connect(store, mapState, { ownPropsModeMerge: true }) without a
 * null mapDispatch placeholder must enable merge mode — not treat options as
 * an empty action-creators map (silent strict props).
 */
import { Component, GraphRuntime, connect, createStore, h } from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

type S = { n: number };
type A = { type: 'INC' };

describe('connect ConnectOptions arity footgun', () => {
  test('store-first: options as 3rd arg (no null mapDispatch) enables merge', async () => {
    const store = createStore<S, A>((state = { n: 0 }, action) => {
      if (action.type === 'INC') {
        return { ...state, n: state.n + 1 };
      }
      return state;
    }, { n: 0 });

    type HostProps = { n?: number; label?: string };

    class Host extends Component<object, HostProps> {
      public seenLabel: string | undefined;

      public constructor (props: HostProps) {
        super(props);
        this.state = {};
      }

      public override onMount (): void {
        this.seenLabel = this.props.label;
      }
    }

    // Footgun call shape that TypeScript allows (3rd param is MapDispatch | ConnectOptions).
    const Connected = connect(
      store,
      (s: S) => ({ n: s.n }),
      { ownPropsModeMerge: true }
    )(Host);

    const hostRef: { current: Host | null } = { current: null };

    class Root extends Component<object, Record<string, never>> {
      public constructor (props: Record<string, never>) {
        super(props);
        this.state = {};
      }

      public override compose (): VirtualServiceNode[] {
        return [h(Connected, { label: 'from-parent' }, hostRef)];
      }
    }

    const rt = await GraphRuntime.mount(h(Root, {}));
    expect(hostRef.current?.seenLabel).toBe('from-parent');
    expect(hostRef.current?.props.label).toBe('from-parent');
    expect(hostRef.current?.props.n).toBe(0);
    await rt.unmount();
  });

  test('child-first: options as 2nd arg (no mapDispatch) enables merge', async () => {
    const store = createStore<S, A>((state = { n: 0 }) => state, { n: 0 });

    type HostProps = { n?: number; label?: string };

    class Host extends Component<object, HostProps> {
      public constructor (props: HostProps) {
        super(props);
        this.state = {};
      }
    }

    const Child = connect(
      (s: S) => ({ n: s.n }),
      { ownPropsModeMerge: true }
    )(Host);

    const childRef: { current: Host | null } = { current: null };

    class Root extends Component<object, Record<string, never>> {
      public constructor (props: Record<string, never>) {
        super(props);
        this.state = {};
      }

      public override compose (): VirtualServiceNode[] {
        return [h(Child, { label: 'from-parent' }, childRef)];
      }
    }

    const ConnectedRoot = connect(store)(Root);
    const rt = await GraphRuntime.mount(h(ConnectedRoot, {}));
    expect(childRef.current?.props.label).toBe('from-parent');
    expect(childRef.current?.props.n).toBe(0);
    await rt.unmount();
  });

  test('explicit null mapDispatch + 4th-arg options still works', async () => {
    const store = createStore<S, A>((state = { n: 0 }) => state, { n: 0 });

    type HostProps = { n?: number; label?: string };

    class Host extends Component<object, HostProps> {
      public constructor (props: HostProps) {
        super(props);
        this.state = {};
      }
    }

    const Connected = connect(
      store,
      (s: S) => ({ n: s.n }),
      null,
      { ownPropsModeMerge: true }
    )(Host);

    const hostRef: { current: Host | null } = { current: null };

    class Root extends Component<object, Record<string, never>> {
      public constructor (props: Record<string, never>) {
        super(props);
        this.state = {};
      }

      public override compose (): VirtualServiceNode[] {
        return [h(Connected, { label: 'from-parent' }, hostRef)];
      }
    }

    const rt = await GraphRuntime.mount(h(Root, {}));
    expect(hostRef.current?.props.label).toBe('from-parent');
    await rt.unmount();
  });

  test('action-creators map that happens to include ownPropsModeMerge still binds functions', () => {
    const store = createStore<S, A>((state = { n: 0 }, action) => {
      if (action.type === 'INC') {
        return { ...state, n: state.n + 1 };
      }
      return state;
    }, { n: 0 });

    type HostProps = { bump?: () => A; ownPropsModeMerge?: boolean };

    class Host extends Component<object, HostProps> {
      public constructor (props: HostProps) {
        super(props);
        this.state = {};
      }
    }

    const Connected = connect(
      store,
      null,
      {
        ownPropsModeMerge: true,
        bump: () => ({ type: 'INC' as const }),
      }
    )(Host);

    const inst = new Connected({});
    void inst.onMount?.();
    // Function value → treated as action creators, not options (strict mode).
    expect(typeof inst.props.bump).toBe('function');
    expect(inst.props.ownPropsModeMerge).toBeUndefined();
    inst.props.bump?.();
    expect(store.getState().n).toBe(1);
  });
});
