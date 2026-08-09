/**
 * Regression tests for class-based `connect`:
 * - onMount subscription and first mapped-pass before super.onMount.
 * - ref-equal fast-exit.
 * - pendingUpdate with asynchronous super.onMount.
 * - onUnmount unsubscribes and calls super.onUnmount exactly once.
 */

import {
  Component,
  EMPTY_CONTEXT_SCOPE,
  GraphRuntime,
  RUNTIME_PROPS_RECEIVER,
  connect,
  createStore,
  getContextFields,
  h,
  injectContextFields,
} from 'Effectable';
import type {
  ActionCreatorsMap,
  DispatchMethod,
  Store,
  VirtualServiceNode,
} from 'Effectable';
import { IS_CONTEXT_PROVIDER } from 'Effectable/component/context';
import { Observable } from 'rxjs';

interface TestStoreState {
  status: string;
  version: number;
}

type TestAction =
  | { type: 'SET_STATUS'; payload: string }
  | { type: 'SET_VERSION'; payload: number };

interface TestProps {
  id: string;
  status?: string;
  version?: number;
}

interface TestComponentState {
  localTick: number;
}

/**
 * Test store reducer for verifying mount/update transitions.
 *
 * @param {TestStoreState} state - current store state
 * @param {TestAction} action - test scenario action
 * @returns {TestStoreState} new store state
 */
function reducer (state: TestStoreState, action: TestAction): TestStoreState {
  switch (action.type) {
    case 'SET_STATUS': {
      return { ...state, status: action.payload };
    }

    case 'SET_VERSION': {
      return { ...state, version: action.payload };
    }

    default: {
      return state;
    }
  }
}

/**
 * Component for verifying synchronous onMount/onUnmount and onUpdate.
 */
class SyncLifecycleComponent extends Component<TestComponentState, TestProps> {
  public readonly lifecycleEvents: string[] = [];

  constructor (props: TestProps) {
    super(props);
    this.state = { localTick: 0 };
  }

  public override onMount (): void {
    this.lifecycleEvents.push(`mount:${this.props.status ?? 'unknown'}`);
  }

  public override onUpdate (
    _prev: TestComponentState,
    _next: TestComponentState
  ): void {
    this.lifecycleEvents.push(
      `update:${this.props.status ?? 'unknown'}:${String(this.props.version ?? -1)}`
    );
  }

  public override onUnmount (): void {
    this.lifecycleEvents.push('unmount');
  }
}

/**
 * Component for verifying deferred update-path with asynchronous super.onMount.
 */
class AsyncLifecycleComponent extends Component<TestComponentState, TestProps> {
  public readonly lifecycleEvents: string[] = [];
  private mountResolve: (() => void) | null = null;

  constructor (props: TestProps) {
    super(props);
    this.state = { localTick: 0 };
  }

  public override async onMount (): Promise<void> {
    this.lifecycleEvents.push(`mount-start:${this.props.status ?? 'unknown'}`);
    await new Promise<void>((resolve) => {
      this.mountResolve = resolve;
    });
    this.lifecycleEvents.push(`mount-complete:${this.props.status ?? 'unknown'}`);
  }

  public override onUpdate (
    _prev: TestComponentState,
    _next: TestComponentState
  ): void {
    this.lifecycleEvents.push(
      `update:${this.props.status ?? 'unknown'}:${String(this.props.version ?? -1)}`
    );
  }

  public releaseMount (): void {
    if (this.mountResolve === null) {
      throw new Error('Mount was not started');
    }

    const resolve = this.mountResolve;
    this.mountResolve = null;
    resolve();
  }
}

/**
 * Creates a wrapped store that counts subscribe/unsubscribe for connect tests.
 *
 * @returns {{ store: Store<TestStoreState, TestAction>, stats: { subscriptions: number, unsubscriptions: number } }}
 */
function createObservedStore (): {
  store: Store<TestStoreState, TestAction>;
  stats: { subscriptions: number; unsubscriptions: number };
} {
  const baseStore = createStore<TestStoreState, TestAction>(reducer, {
    status: 'idle',
    version: 0,
  });
  const stats = {
    subscriptions: 0,
    unsubscriptions: 0,
  };

  const observedStore: Store<TestStoreState, TestAction> = {
    dispatch: (action) => baseStore.dispatch(action),
    getState: () => baseStore.getState(),
    state$: baseStore.state$,
    select: <T>(selectorFn: (state: TestStoreState) => T): Observable<T> => {
      return new Observable<T>((subscriber) => {
        stats.subscriptions += 1;
        const subscription = baseStore.select(selectorFn).subscribe({
          next: (value: T): void => {
            subscriber.next(value);
          },
          error: (error: unknown): void => {
            subscriber.error(error);
          },
          complete: (): void => {
            subscriber.complete();
          },
        });

        return (): void => {
          stats.unsubscriptions += 1;
          subscription.unsubscribe();
        };
      });
    },
    destroy: () => {
      baseStore.destroy();
    },
  };

  return {
    store: observedStore,
    stats,
  };
}

describe('Effectable.connect (class-based HOC)', () => {
  test('onMount performs the first mapped-pass and calls super.onMount before onUpdate', () => {
    const store = createStore<TestStoreState, TestAction>(reducer, {
      status: 'idle',
      version: 0,
    });
    const Connected = connect<
      TestStoreState,
      TestProps,
      Pick<TestProps, 'status' | 'version'>
    >(
      store,
      (state: TestStoreState) => ({ status: state.status, version: state.version })
    )(SyncLifecycleComponent);

    const instance = new Connected({ id: 'sync-case' }) as SyncLifecycleComponent;
    instance.onMount?.();

    expect(instance.props.status).toBe('idle');
    expect(instance.lifecycleEvents).toEqual(['mount:idle']);

    store.dispatch({ type: 'SET_STATUS', payload: 'running' });

    expect(instance.lifecycleEvents).toEqual([
      'mount:idle',
      'update:running:0',
    ]);

    instance.onUnmount?.();
    expect(instance.lifecycleEvents).toEqual([
      'mount:idle',
      'update:running:0',
      'unmount',
    ]);
  });

  test('does not call onUpdate before async super.onMount finishes and then replays the pending update', async () => {
    const store = createStore<TestStoreState, TestAction>(reducer, {
      status: 'idle',
      version: 0,
    });
    const Connected = connect<
      TestStoreState,
      TestProps,
      Pick<TestProps, 'status' | 'version'>
    >(
      store,
      (state: TestStoreState) => ({ status: state.status, version: state.version })
    )(AsyncLifecycleComponent);

    const instance = new Connected({ id: 'async-case' }) as AsyncLifecycleComponent;
    const mountPromise = instance.onMount?.();

    store.dispatch({ type: 'SET_STATUS', payload: 'running' });

    expect(instance.lifecycleEvents).toEqual(['mount-start:idle']);

    instance.releaseMount();
    await mountPromise;
    await Promise.resolve();

    expect(instance.lifecycleEvents).toEqual([
      'mount-start:idle',
      'mount-complete:running',
      'update:running:0',
    ]);

    instance.onUnmount?.();
  });

  test('repeated onUnmount does not break and unsubscribe is idempotent', () => {
    const store = createStore<TestStoreState, TestAction>(reducer, {
      status: 'idle',
      version: 0,
    });
    const Connected = connect<
      TestStoreState,
      TestProps,
      Pick<TestProps, 'status' | 'version'>
    >(
      store,
      (state: TestStoreState) => ({ status: state.status, version: state.version })
    )(SyncLifecycleComponent);

    const instance = new Connected({ id: 'unmount-case' }) as SyncLifecycleComponent;
    instance.onMount?.();
    instance.onUnmount?.();
    instance.onUnmount?.();

    store.dispatch({ type: 'SET_STATUS', payload: 'running-after-unmount' });

    expect(instance.lifecycleEvents).toEqual([
      'mount:idle',
      'unmount',
      'unmount',
    ]);
  });

  test('connect: mapDispatchToProps only — no state subscription, callbacks in props before super.onMount', () => {
    const store = createStore<TestStoreState, TestAction>(reducer, {
      status: 'idle',
      version: 0,
    });

    interface DispatchProps {
      setVersion?: (n: number) => void;
    }

    class DispatchOnly extends Component<object, TestProps & DispatchProps> {
      public dispatchVisibleInOnMount = false;

      constructor (props: TestProps & DispatchProps) {
        super(props);
      }

      public override onMount (): void {
        this.dispatchVisibleInOnMount =
          typeof this.props.setVersion === 'function';
      }
    }

    const Connected = connect(
      store,
      undefined,
      (dispatch: DispatchMethod<TestAction>) => ({
        setVersion: (n: number) => dispatch({ type: 'SET_VERSION', payload: n }),
      })
    )(DispatchOnly);

    const instance = new Connected({ id: 'dispatch-only' }) as DispatchOnly;
    instance.onMount?.();

    expect(instance.dispatchVisibleInOnMount).toBe(true);
    instance.props.setVersion?.(42);
    expect(store.getState().version).toBe(42);

    instance.onUnmount?.();
  });

  test('mapDispatch: named function of dispatch only is passed without wrapping (d) => fn(d)', () => {
    const store = createStore<TestStoreState, TestAction>(reducer, {
      status: 'idle',
      version: 0,
    });

    interface DispatchProps {
      setVersion?: (n: number) => void;
    }

    function mapDispatchOnly (
      dispatch: DispatchMethod<TestAction>
    ): Pick<DispatchProps, 'setVersion'> {
      return {
        setVersion: (n: number) => dispatch({ type: 'SET_VERSION', payload: n }),
      };
    }

    class DispatchNamed extends Component<object, TestProps & DispatchProps> {
      public ok = false;

      public override onMount (): void {
        this.ok = typeof this.props.setVersion === 'function';
      }
    }

    const Connected = connect(store, undefined, mapDispatchOnly)(DispatchNamed);

    const instance = new Connected({ id: 'named-dispatch' }) as DispatchNamed;
    instance.onMount?.();
    expect(instance.ok).toBe(true);
    instance.props.setVersion?.(7);
    expect(store.getState().version).toBe(7);
    instance.onUnmount?.();
  });

  test('mapDispatch: action creators object — dispatch(actionCreator(...args))', () => {
    const store = createStore<TestStoreState, TestAction>(reducer, {
      status: 'idle',
      version: 0,
    });

    interface AcProps {
      bumpVersion?: (n: number) => void;
    }

    const actionCreators: ActionCreatorsMap<TestAction> = {
      bumpVersion: (...args: unknown[]) =>
        ({ type: 'SET_VERSION', payload: args[0] as number }) as TestAction,
    };

    class AcCmp extends Component<object, TestProps & AcProps> {
      public ok = false;

      public override onMount (): void {
        this.ok = typeof this.props.bumpVersion === 'function';
      }
    }

    const Connected = connect(store, undefined, actionCreators)(AcCmp);

    const instance = new Connected({ id: 'ac-map' }) as AcCmp;
    instance.onMount?.();
    expect(instance.ok).toBe(true);
    instance.props.bumpVersion?.(3);
    expect(store.getState().version).toBe(3);
    instance.onUnmount?.();
  });

  test('child connected component receives store from connected parent via context', async () => {
    const store = createStore<TestStoreState, TestAction>(reducer, {
      status: 'idle',
      version: 0,
    });
    const lifecycleEvents: string[] = [];

    interface ImplicitDispatchProps {
      setVersion?: (n: number) => void;
    }

    class ImplicitStoreChild extends Component<object, TestProps & ImplicitDispatchProps> {
      public override onMount (): void {
        lifecycleEvents.push(
          `mount:${this.props.status ?? 'unknown'}:${String(this.props.version ?? -1)}:${typeof this.props.setVersion === 'function'}`
        );
      }

      public override onUpdate (): void {
        lifecycleEvents.push(
          `update:${this.props.status ?? 'unknown'}:${String(this.props.version ?? -1)}`
        );
      }

      public override onUnmount (): void {
        lifecycleEvents.push('unmount');
      }
    }

    const ConnectedImplicitStoreChild = connect(
      (state: TestStoreState): Pick<TestProps, 'status' | 'version'> => ({
        status: state.status,
        version: state.version,
      }),
      (dispatch: DispatchMethod<TestAction>): Pick<ImplicitDispatchProps, 'setVersion'> => ({
        setVersion: (n: number): void => {
          dispatch({ type: 'SET_VERSION', payload: n });
        },
      })
    )(ImplicitStoreChild);

    class ConnectedRootHost extends Component<object, Record<string, never>> {
      public override compose (): VirtualServiceNode[] {
        return [
          h(ConnectedImplicitStoreChild, { id: 'implicit-store-child' }),
        ];
      }
    }

    const ConnectedRootHostWithStore = connect(store)(ConnectedRootHost);
    const runtime = await GraphRuntime.mount(
      h(ConnectedRootHostWithStore, {})
    );

    // Child with mapState: after await mount the microtask kick-off already delivered one onUpdate.
    expect(lifecycleEvents).toEqual([
      'mount:idle:0:true',
      'update:idle:0',
    ]);

    store.dispatch({ type: 'SET_STATUS', payload: 'running' });
    expect(lifecycleEvents).toEqual([
      'mount:idle:0:true',
      'update:idle:0',
      'update:running:0',
    ]);

    await runtime.unmount();
    expect(lifecycleEvents).toEqual([
      'mount:idle:0:true',
      'update:idle:0',
      'update:running:0',
      'unmount',
    ]);
  });

  describe('reconcile and props', () => {
    test('reconcile keeps state-derived props on parent update', async () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      class ReconcileStateChild extends Component<object, TestProps> {
        constructor (props: TestProps) {
          super(props);
          this.state = {};
        }
      }

      const childRef: { current: ReconcileStateChild | null } = { current: null };

      const ConnectedStateChild = connect<
        TestStoreState,
        TestProps,
        Pick<TestProps, 'status' | 'version'>
      >(
        (state: TestStoreState): Pick<TestProps, 'status' | 'version'> => ({
          status: state.status,
          version: state.version,
        }),
        undefined,
        { ownPropsModeMerge: true }
      )(ReconcileStateChild);

      interface RootProps {
        childId: string;
      }

      class RootHost extends Component<object, RootProps> {
        public override compose (): VirtualServiceNode[] {
          return [
            h(ConnectedStateChild, { id: this.props.childId }, childRef),
          ];
        }
      }

      // RootHost reads this.props.childId in compose -> legacy merge, otherwise strict strips props
      const ConnectedRootHost = connect(store, undefined, undefined, { ownPropsModeMerge: true })(RootHost);
      const runtime = await GraphRuntime.mount(
        h(ConnectedRootHost, { childId: 'first' })
      );

      if (childRef.current === null) {
        throw new Error('Child ref was not attached');
      }

      expect(childRef.current.props).toEqual({
        id: 'first',
        status: 'idle',
        version: 0,
      });

      await runtime.reconcile(
        h(ConnectedRootHost, { childId: 'second' })
      );

      if (childRef.current === null) {
        throw new Error('Child ref was detached after reconcile');
      }

      expect(childRef.current.props).toEqual({
        id: 'second',
        status: 'idle',
        version: 0,
      });

      await runtime.unmount();
    });

    test('reconcile keeps dispatch props on parent update', async () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      interface DispatchProbeProps extends TestProps {
        emitOwnId?: () => void;
      }

      class ReconcileDispatchChild extends Component<object, DispatchProbeProps> {
        constructor (props: DispatchProbeProps) {
          super(props);
          this.state = {};
        }
      }

      const childRef: { current: ReconcileDispatchChild | null } = { current: null };

      const ConnectedDispatchChild = connect<
        TestStoreState,
        DispatchProbeProps,
        unknown,
        TestAction
      >(
        undefined,
        (
          dispatch: DispatchMethod<TestAction>,
          props: DispatchProbeProps
        ): Pick<DispatchProbeProps, 'emitOwnId'> => ({
          emitOwnId: (): void => {
            dispatch({ type: 'SET_STATUS', payload: props.id });
          },
        })
      )(ReconcileDispatchChild);

      interface RootProps {
        childId: string;
      }

      class RootHost extends Component<object, RootProps> {
        public override compose (): VirtualServiceNode[] {
          return [
            h(ConnectedDispatchChild, { id: this.props.childId }, childRef),
          ];
        }
      }

      // RootHost reads this.props.childId in compose -> legacy merge, otherwise strict strips props
      const ConnectedRootHost = connect(store, undefined, undefined, { ownPropsModeMerge: true })(RootHost);
      const runtime = await GraphRuntime.mount(
        h(ConnectedRootHost, { childId: 'first' })
      );

      if (childRef.current === null) {
        throw new Error('Child ref was not attached');
      }

      expect(typeof childRef.current.props.emitOwnId).toBe('function');

      await runtime.reconcile(
        h(ConnectedRootHost, { childId: 'second' })
      );

      if (childRef.current === null) {
        throw new Error('Child ref was detached after reconcile');
      }

      expect(typeof childRef.current.props.emitOwnId).toBe('function');
      childRef.current.props.emitOwnId?.();
      expect(store.getState().status).toBe('second');

      await runtime.unmount();
    });

    test('mapDispatch(dispatch, props) rebinding uses new props after parent update', async () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      interface RebindingProps extends TestProps {
        emitOwnId?: () => void;
      }

      class RebindingDispatchChild extends Component<object, RebindingProps> {
        constructor (props: RebindingProps) {
          super(props);
          this.state = {};
        }
      }

      const childRef: { current: RebindingDispatchChild | null } = { current: null };

      const ConnectedDispatchChild = connect<
        TestStoreState,
        RebindingProps,
        unknown,
        TestAction
      >(
        undefined,
        (
          dispatch: DispatchMethod<TestAction>,
          props: RebindingProps
        ): Pick<RebindingProps, 'emitOwnId'> => ({
          emitOwnId: (): void => {
            dispatch({ type: 'SET_STATUS', payload: props.id });
          },
        })
      )(RebindingDispatchChild);

      interface RootProps {
        childId: string;
      }

      class RootHost extends Component<object, RootProps> {
        public override compose (): VirtualServiceNode[] {
          return [
            h(ConnectedDispatchChild, { id: this.props.childId }, childRef),
          ];
        }
      }

      // RootHost reads this.props.childId in compose -> legacy merge, otherwise strict strips props
      const ConnectedRootHost = connect(store, undefined, undefined, { ownPropsModeMerge: true })(RootHost);
      const runtime = await GraphRuntime.mount(
        h(ConnectedRootHost, { childId: 'before-rebind' })
      );

      if (childRef.current === null) {
        throw new Error('Child ref was not attached');
      }

      const initialEmitter = childRef.current.props.emitOwnId;
      initialEmitter?.();
      expect(store.getState().status).toBe('before-rebind');

      await runtime.reconcile(
        h(ConnectedRootHost, { childId: 'after-rebind' })
      );

      if (childRef.current === null) {
        throw new Error('Child ref was detached after reconcile');
      }

      expect(childRef.current.props.emitOwnId).not.toBe(initialEmitter);
      childRef.current.props.emitOwnId?.();
      expect(store.getState().status).toBe('after-rebind');

      await runtime.unmount();
    });

    test('mapStateToProps(state, props) recomputes synchronously on reconcile props without store emission', async () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      interface DerivedProps extends TestProps {
        derived?: string;
      }

      class ReconcileDerivedChild extends Component<object, DerivedProps> {
        constructor (props: DerivedProps) {
          super(props);
          this.state = {};
        }
      }

      const childRef: { current: ReconcileDerivedChild | null } = { current: null };

      const ConnectedDerivedChild = connect<
        TestStoreState,
        DerivedProps,
        Pick<DerivedProps, 'derived'>
      >(
        (state: TestStoreState, props: DerivedProps): Pick<DerivedProps, 'derived'> => ({
          derived: `${props.id}:${state.status}`,
        })
      )(ReconcileDerivedChild);

      interface RootProps {
        childId: string;
      }

      class RootHost extends Component<object, RootProps> {
        public override compose (): VirtualServiceNode[] {
          return [
            h(ConnectedDerivedChild, { id: this.props.childId }, childRef),
          ];
        }
      }

      // RootHost reads this.props.childId in compose -> legacy merge, otherwise strict strips props
      const ConnectedRootHost = connect(store, undefined, undefined, { ownPropsModeMerge: true })(RootHost);
      const runtime = await GraphRuntime.mount(
        h(ConnectedRootHost, { childId: 'first' })
      );

      if (childRef.current === null) {
        throw new Error('Child ref was not attached');
      }

      expect(childRef.current.props.derived).toBe('first:idle');

      // reconcile changes props.id, store does not emit — derived must update synchronously
      await runtime.reconcile(
        h(ConnectedRootHost, { childId: 'second' })
      );

      if (childRef.current === null) {
        throw new Error('Child ref was detached after reconcile');
      }

      expect(childRef.current.props.derived).toBe('second:idle');

      await runtime.unmount();
    });
  });

  describe('async failure / cleanup semantics', () => {
    test('GraphRuntime.mount rejects on failed async mount of a connected component', async () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });
      const lifecycleEvents: string[] = [];
      const failure = new Error('async mount failed');

      class FailingAsyncMount extends Component<object, TestProps> {
        constructor (props: TestProps) {
          super(props);
          this.state = {};
        }

        public override async onMount (): Promise<void> {
          lifecycleEvents.push(`mount-start:${this.props.status ?? 'unknown'}`);
          throw failure;
        }
      }

      const Connected = connect<
        TestStoreState,
        TestProps,
        Pick<TestProps, 'status'>
      >(
        store,
        (state: TestStoreState): Pick<TestProps, 'status'> => ({
          status: state.status,
        })
      )(FailingAsyncMount);

      await expect(
        GraphRuntime.mount(h(Connected, { id: 'failed-async-mount' }))
      ).rejects.toBe(failure);
      expect(lifecycleEvents).toEqual(['mount-start:idle']);
    });

    test('after failed startup the store subscription is removed', async () => {
      const { store, stats } = createObservedStore();

      class FailingAsyncMount extends Component<object, TestProps> {
        constructor (props: TestProps) {
          super(props);
          this.state = {};
        }

        public override async onMount (): Promise<void> {
          throw new Error('startup failed');
        }
      }

      const Connected = connect<
        TestStoreState,
        TestProps,
        Pick<TestProps, 'status'>
      >(
        store,
        (state: TestStoreState): Pick<TestProps, 'status'> => ({
          status: state.status,
        })
      )(FailingAsyncMount);

      await expect(
        GraphRuntime.mount(h(Connected, { id: 'failed-cleanup' }))
      ).rejects.toThrow('startup failed');
      expect(stats).toEqual({
        subscriptions: 1,
        unsubscriptions: 1,
      });

      store.destroy();
    });

    test('after failed startup there is no post-failure update activity', async () => {
      const { store } = createObservedStore();
      const lifecycleEvents: string[] = [];

      class FailingAsyncMount extends Component<object, TestProps> {
        constructor (props: TestProps) {
          super(props);
          this.state = {};
        }

        public override async onMount (): Promise<void> {
          lifecycleEvents.push(`mount-start:${this.props.status ?? 'unknown'}`);
          throw new Error('startup failed');
        }

        public override onUpdate (): void {
          lifecycleEvents.push(`update:${this.props.status ?? 'unknown'}`);
        }
      }

      const Connected = connect<
        TestStoreState,
        TestProps,
        Pick<TestProps, 'status'>
      >(
        store,
        (state: TestStoreState): Pick<TestProps, 'status'> => ({
          status: state.status,
        })
      )(FailingAsyncMount);

      await expect(
        GraphRuntime.mount(h(Connected, { id: 'failed-no-post-update' }))
      ).rejects.toThrow('startup failed');

      store.dispatch({ type: 'SET_STATUS', payload: 'after-failure' });
      await Promise.resolve();

      expect(lifecycleEvents).toEqual(['mount-start:idle']);
      store.destroy();
    });

    test('sync throw in super.onMount on first pass removes the store subscription', async () => {
      const { store, stats } = createObservedStore();

      class FailingSyncMount extends Component<object, TestProps> {
        constructor (props: TestProps) {
          super(props);
          this.state = {};
        }

        public override onMount (): void {
          throw new Error('sync mount failed');
        }
      }

      const Connected = connect<
        TestStoreState,
        TestProps,
        Pick<TestProps, 'status'>
      >(
        store,
        (state: TestStoreState): Pick<TestProps, 'status'> => ({
          status: state.status,
        }),
      )(FailingSyncMount);

      await expect(
        GraphRuntime.mount(h(Connected, { id: 'failed-sync-mount' })),
      ).rejects.toThrow('sync mount failed');

      expect(stats).toEqual({
        subscriptions: 1,
        unsubscriptions: 1,
      });

      store.destroy();
    });
  });

  describe('negative-path and boundary API', () => {
    test('nested connected without a connected parent throws an explicit store error', async () => {
      class OrphanConnectedChild extends Component<object, TestProps> {
        constructor (props: TestProps) {
          super(props);
          this.state = {};
        }
      }

      const ConnectedOrphanChild = connect<
        TestStoreState,
        TestProps,
        Pick<TestProps, 'status'>
      >(
        (state: TestStoreState): Pick<TestProps, 'status'> => ({
          status: state.status,
        })
      )(OrphanConnectedChild);

      class PlainParent extends Component<object, Record<string, never>> {
        public override compose (): VirtualServiceNode[] {
          return [
            h(ConnectedOrphanChild, { id: 'orphan-child' }),
          ];
        }
      }

      await expect(
        GraphRuntime.mount(h(PlainParent, {}))
      ).rejects.toThrow('Store is not available');
    });

    test('invalid mapStateToProps result does not break mount and does not add mapped props', () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      class InvalidMapStateComponent extends Component<object, TestProps> {
        public seenStatus = 'missing';

        constructor (props: TestProps) {
          super(props);
          this.state = {};
        }

        public override onMount (): void {
          this.seenStatus = this.props.status ?? 'missing';
        }
      }

      const Connected = connect<TestStoreState, TestProps, unknown>(
        store,
        (): unknown => 'not-an-object',
        undefined,
        { ownPropsModeMerge: true }
      )(InvalidMapStateComponent);

      const instance = new Connected({ id: 'invalid-map-state' }) as InvalidMapStateComponent;
      instance.onMount?.();

      expect(instance.seenStatus).toBe('missing');
      expect(instance.props).toEqual({ id: 'invalid-map-state' });
      instance.onUnmount?.();
    });

    test('invalid mapDispatchToProps result is silently ignored', () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      interface InvalidDispatchProps extends TestProps {
        setVersion?: (value: number) => void;
      }

      class InvalidMapDispatchComponent extends Component<object, InvalidDispatchProps> {
        public hasDispatchProp = false;

        constructor (props: InvalidDispatchProps) {
          super(props);
          this.state = {};
        }

        public override onMount (): void {
          this.hasDispatchProp = typeof this.props.setVersion === 'function';
        }
      }

      const Connected = connect<
        TestStoreState,
        InvalidDispatchProps,
        unknown,
        TestAction
      >(
        store,
        undefined,
        (_dispatch: DispatchMethod<TestAction>): unknown => 'not-an-object',
        { ownPropsModeMerge: true }
      )(InvalidMapDispatchComponent);

      const instance = new Connected({ id: 'invalid-map-dispatch' }) as InvalidMapDispatchComponent;
      instance.onMount?.();

      expect(instance.hasDispatchProp).toBe(false);
      expect(instance.props).toEqual({ id: 'invalid-map-dispatch' });
      instance.onUnmount?.();
    });

    test('mixed object-form action creators sanitizes non-functions and binds only valid creators', () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      interface MixedActionCreatorProps extends TestProps {
        bumpVersion?: (value: number) => void;
        ignoredValue?: unknown;
      }

      class MixedActionCreatorComponent extends Component<object, MixedActionCreatorProps> {
        constructor (props: MixedActionCreatorProps) {
          super(props);
          this.state = {};
        }
      }

      const mixedActionCreators: Record<string, unknown> = {
        bumpVersion: (...args: unknown[]): TestAction => {
          const value = args[0];
          if (typeof value !== 'number') {
            throw new Error('Expected numeric payload');
          }

          return { type: 'SET_VERSION', payload: value };
        },
        ignoredValue: 123,
        ignoredText: 'skip-me',
      };

      const Connected = connect<
        TestStoreState,
        MixedActionCreatorProps,
        unknown,
        TestAction
      >(
        store,
        undefined,
        // Boundary-path test: emulate an incorrect JS call of object-form mapDispatch with mixed values.
        mixedActionCreators as unknown as ActionCreatorsMap<TestAction>
      )(MixedActionCreatorComponent);

      const instance = new Connected({ id: 'mixed-creators' }) as MixedActionCreatorComponent;
      instance.onMount?.();

      expect(typeof instance.props.bumpVersion).toBe('function');
      expect(instance.props.ignoredValue).toBeUndefined();

      instance.props.bumpVersion?.(9);
      expect(store.getState().version).toBe(9);
      instance.onUnmount?.();
    });

    // Covered in "reconcile and props" -> "mapStateToProps(state, props) recomputes
    // synchronously on reconcile props without store emission".
  });

  describe('automatic reconcile on connect selector update', () => {
    interface AutoReconcileStoreState {
      showChild: boolean;
      childVersion: number;
    }

    type AutoReconcileAction =
      | { type: 'SHOW_CHILD' }
      | { type: 'HIDE_CHILD' }
      | { type: 'BUMP_VERSION' };

    function autoReconcileReducer (
      state: AutoReconcileStoreState,
      action: AutoReconcileAction,
    ): AutoReconcileStoreState {
      switch (action.type) {
        case 'SHOW_CHILD': return { ...state, showChild: true };
        case 'HIDE_CHILD': return { ...state, showChild: false };
        case 'BUMP_VERSION': return { ...state, childVersion: state.childVersion + 1 };
        default: return state;
      }
    }

    interface AutoRootMappedProps {
      tag: string;
      showChild?: boolean;
    }

    test('selector update mounts a child from compose() without calling runtime.reconcile()', async () => {
      const store = createStore<AutoReconcileStoreState, AutoReconcileAction>(
        autoReconcileReducer,
        { showChild: false, childVersion: 0 },
      );

      let childMountCount = 0;

      class AutoMountChild extends Component<object, { version: number }> {
        constructor (props: { version: number }) {
          super(props);
          this.state = {};
        }

        public override onMount (): void {
          childMountCount += 1;
        }
      }

      class AutoMountRoot extends Component<object, AutoRootMappedProps> {
        public override compose (): VirtualServiceNode | null {
          return this.props.showChild
            ? h(AutoMountChild, { version: 0 })
            : null;
        }
      }

      const ConnectedRoot = connect<
        AutoReconcileStoreState,
        AutoRootMappedProps,
        Pick<AutoRootMappedProps, 'showChild'>
      >(
        store,
        (state: AutoReconcileStoreState) => ({ showChild: state.showChild }),
      )(AutoMountRoot);

      const runtime = await GraphRuntime.mount(h(ConnectedRoot, { tag: 'auto-mount' }));

      expect(childMountCount).toBe(0);

      store.dispatch({ type: 'SHOW_CHILD' });

      // selector update calls connect.setState({}) → SCHEDULE_UPDATE_HOOK → queueMicrotask
      // microtask not yet run — child not yet mounted
      expect(childMountCount).toBe(0);

      await Promise.resolve(); // flushDirtyFibers runs

      expect(childMountCount).toBe(1);

      await runtime.unmount();
    });

    test('selector update unmounts a child from compose() without calling runtime.reconcile()', async () => {
      // setImmediate establishes a macrotask barrier: by then all pending microtasks
      // (including the async reconcileChildrenFullDiff → .then → flush-continuation chain)
      // are fully drained. Important for the test where HIDE_CHILD dispatch must
      // see updated fiber.children after SHOW_CHILD flush completes.
      const drainFlush = (): Promise<void> =>
        new Promise<void>((resolve) => setImmediate(resolve));

      const store = createStore<AutoReconcileStoreState, AutoReconcileAction>(
        autoReconcileReducer,
        { showChild: false, childVersion: 0 },
      );

      let childMountCount2 = 0;
      let childUnmountCount = 0;

      class AutoUnmountChild extends Component<object, { version: number }> {
        constructor (props: { version: number }) {
          super(props);
          this.state = {};
        }

        public override onMount (): void {
          childMountCount2 += 1;
        }

        public override onUnmount (): void {
          childUnmountCount += 1;
        }
      }

      class AutoUnmountRoot extends Component<object, AutoRootMappedProps> {
        public override compose (): VirtualServiceNode | null {
          return this.props.showChild
            ? h(AutoUnmountChild, { version: 0 })
            : null;
        }
      }

      const ConnectedRoot = connect<
        AutoReconcileStoreState,
        AutoRootMappedProps,
        Pick<AutoRootMappedProps, 'showChild'>
      >(
        store,
        (state: AutoReconcileStoreState) => ({ showChild: state.showChild }),
      )(AutoUnmountRoot);

      const runtime = await GraphRuntime.mount(h(ConnectedRoot, { tag: 'auto-unmount' }));

      expect(childMountCount2).toBe(0);
      expect(childUnmountCount).toBe(0);

      // First mount the child via selector update (without runtime.reconcile())
      // drainFlush ensures fiber.children is updated and flushing is cleared
      store.dispatch({ type: 'SHOW_CHILD' });
      await drainFlush();
      expect(childMountCount2).toBe(1);

      // Now unmount the child via selector update without calling runtime.reconcile()
      store.dispatch({ type: 'HIDE_CHILD' });

      expect(childUnmountCount).toBe(0);

      await Promise.resolve(); // flushDirtyFibers runs, onUnmount is called synchronously

      expect(childUnmountCount).toBe(1);

      await runtime.unmount();
    });

    test('several consecutive dispatches coalesce into one reconcile pass', async () => {
      const store = createStore<AutoReconcileStoreState, AutoReconcileAction>(
        autoReconcileReducer,
        { showChild: false, childVersion: 0 },
      );

      interface CoalesceRootMappedProps {
        tag: string;
        childVersion?: number;
      }

      let composeCallsAfterMount = 0;

      class CoalesceRoot extends Component<object, CoalesceRootMappedProps> {
        public override compose (): null {
          composeCallsAfterMount += 1;
          return null;
        }
      }

      const ConnectedCoalesceRoot = connect<
        AutoReconcileStoreState,
        CoalesceRootMappedProps,
        Pick<CoalesceRootMappedProps, 'childVersion'>
      >(
        store,
        (state: AutoReconcileStoreState) => ({ childVersion: state.childVersion }),
      )(CoalesceRoot);

      const runtime = await GraphRuntime.mount(h(ConnectedCoalesceRoot, { tag: 'coalesce' }));

      // Reset the counter after the initial materialize
      composeCallsAfterMount = 0;

      // Three consecutive dispatches before the next microtask checkpoint:
      // each calls setState({}) → SCHEDULE_UPDATE_HOOK → scheduleUpdate(fiber)
      // but flushScheduled = true after the first, so no new microtask is added
      store.dispatch({ type: 'BUMP_VERSION' });
      store.dispatch({ type: 'BUMP_VERSION' });
      store.dispatch({ type: 'BUMP_VERSION' });

      await Promise.resolve(); // single flush

      // Three dispatches — one reconcile (compose() called exactly once)
      expect(composeCallsAfterMount).toBe(1);

      await runtime.unmount();
    });
  });

  describe('strict props filtering (strict by default, ownPropsModeMerge for legacy)', () => {
    interface StrictChildProps {
      id: string;
      hiddenOwnProp?: string;
      setVersion?: (n: number) => void;
    }

    test('strict: own prop does NOT appear in this.props if the mapper did not return it', async () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      const childRef: { current: Component<object, StrictChildProps> | null } = { current: null };

      class StrictChild extends Component<object, StrictChildProps> {
        constructor (props: StrictChildProps) {
          super(props);
          this.state = {};
        }
      }

      const ConnectedStrictChild = connect<
        TestStoreState,
        StrictChildProps,
        unknown,
        TestAction
      >(
        undefined,
        (dispatch: DispatchMethod<TestAction>): Pick<StrictChildProps, 'setVersion'> => ({
          setVersion: (n: number): void => {
            dispatch({ type: 'SET_VERSION', payload: n });
          },
        })
      )(StrictChild);

      class RootHost extends Component<object, Record<string, never>> {
        public override compose (): VirtualServiceNode[] {
          return [
            h(ConnectedStrictChild, { id: 'strict-neg', hiddenOwnProp: 'leaked' }, childRef),
          ];
        }
      }

      const ConnectedRootHost = connect(store)(RootHost);
      const runtime = await GraphRuntime.mount(h(ConnectedRootHost, {}));

      if (childRef.current === null) {
        throw new Error('Child ref was not attached');
      }

      // hiddenOwnProp and id not returned by mapper -> absent from public props
      expect(childRef.current.props.hiddenOwnProp).toBeUndefined();
      expect(childRef.current.props.id).toBeUndefined();
      // dispatch prop from the mapper is present
      expect(typeof childRef.current.props.setVersion).toBe('function');

      await runtime.unmount();
    });

    test('strict: own prop appears in this.props if mapStateToProps(state, props) explicitly returned it', async () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      const childRef: { current: Component<object, StrictChildProps> | null } = { current: null };

      class StrictChild extends Component<object, StrictChildProps> {
        constructor (props: StrictChildProps) {
          super(props);
          this.state = {};
        }
      }

      const ConnectedStrictChild = connect<
        TestStoreState,
        StrictChildProps,
        Pick<StrictChildProps, 'hiddenOwnProp'>,
        TestAction
      >(
        (_state: TestStoreState, props: StrictChildProps): Pick<StrictChildProps, 'hiddenOwnProp'> => ({
          hiddenOwnProp: props.hiddenOwnProp,
        })
      )(StrictChild);

      class RootHost extends Component<object, Record<string, never>> {
        public override compose (): VirtualServiceNode[] {
          return [
            h(ConnectedStrictChild, { id: 'strict-pos', hiddenOwnProp: 'passed-through' }, childRef),
          ];
        }
      }

      const ConnectedRootHost = connect(store)(RootHost);
      const runtime = await GraphRuntime.mount(h(ConnectedRootHost, {}));

      if (childRef.current === null) {
        throw new Error('Child ref was not attached');
      }

      // explicitly forwarded prop is present
      expect(childRef.current.props.hiddenOwnProp).toBe('passed-through');
      // non-forwarded id is absent
      expect(childRef.current.props.id).toBeUndefined();

      await runtime.unmount();
    });

    test('merge (legacy, explicit ownPropsModeMerge: true): own prop is forwarded into this.props without a mapper', async () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      const childRef: { current: Component<object, StrictChildProps> | null } = { current: null };

      class MergeChild extends Component<object, StrictChildProps> {
        constructor (props: StrictChildProps) {
          super(props);
          this.state = {};
        }
      }

      // legacy merge: parent props are forwarded into this.props without a mapper
      const ConnectedMergeChild = connect<
        TestStoreState,
        StrictChildProps,
        unknown,
        TestAction
      >(
        undefined,
        undefined,
        { ownPropsModeMerge: true }
      )(MergeChild);

      class RootHost extends Component<object, Record<string, never>> {
        public override compose (): VirtualServiceNode[] {
          return [
            h(ConnectedMergeChild, { id: 'merge-default', hiddenOwnProp: 'forwarded' }, childRef),
          ];
        }
      }

      const ConnectedRootHost = connect(store)(RootHost);
      const runtime = await GraphRuntime.mount(h(ConnectedRootHost, {}));

      if (childRef.current === null) {
        throw new Error('Child ref was not attached');
      }

      expect(childRef.current.props.hiddenOwnProp).toBe('forwarded');
      expect(childRef.current.props.id).toBe('merge-default');

      await runtime.unmount();
    });
  });

  describe('post-mount kick-off, props merge, context provider, and unmount', () => {
    test('post-mount kick-off yields exactly one onUpdate (queueMicrotask), without a duplicate', async () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      class KickoffProbe extends Component<TestComponentState, Pick<TestProps, 'status'>> {
        public readonly updateLog: string[] = [];

        constructor (props: Pick<TestProps, 'status'>) {
          super(props as TestProps);
          this.state = { localTick: 0 };
        }

        public override onUpdate (): void {
          this.updateLog.push(`update:${this.props.status ?? 'unknown'}`);
        }
      }

      const Connected = connect<
        TestStoreState,
        Pick<TestProps, 'status'>,
        Pick<TestProps, 'status'>
      >(
        store,
        (state: TestStoreState): Pick<TestProps, 'status'> => ({ status: state.status })
      )(KickoffProbe);

      const probeRef: { current: KickoffProbe | null } = { current: null };
      const runtime = await GraphRuntime.mount(
        h(Connected, {}, probeRef)
      );

      await Promise.resolve();
      await Promise.resolve();

      if (probeRef.current === null) {
        throw new Error('Kickoff probe ref was not attached');
      }

      const instance = probeRef.current;
      expect(instance.updateLog).toEqual(['update:idle']);

      store.dispatch({ type: 'SET_STATUS', payload: 'running' });
      await Promise.resolve();

      expect(instance.updateLog).toEqual(['update:idle', 'update:running']);

      await runtime.unmount();
      store.destroy();
    });

    test('pending flush in sync onMount blocks a duplicate post-mount kick-off', async () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      interface DispatchMountProps {
        version?: number;
        bumpVersion?: (n: number) => void;
      }

      class DispatchInMount extends Component<object, DispatchMountProps> {
        public readonly updateEvents: string[] = [];

        public override onMount (): void {
          const bumpVersion = this.props.bumpVersion;
          if (bumpVersion === undefined) {
            throw new Error('bumpVersion is not mapped');
          }

          bumpVersion(1);
        }

        public override onUpdate (): void {
          this.updateEvents.push(`update:${String(this.props.version ?? -1)}`);
        }
      }

      const Connected = connect<
        TestStoreState,
        DispatchMountProps,
        Pick<DispatchMountProps, 'version'>
      >(
        store,
        (state: TestStoreState): Pick<DispatchMountProps, 'version'> => ({
          version: state.version,
        }),
        (dispatch: DispatchMethod<TestAction>): Pick<DispatchMountProps, 'bumpVersion'> => ({
          bumpVersion: (n: number): void => {
            dispatch({ type: 'SET_VERSION', payload: n });
          },
        })
      )(DispatchInMount);

      const mountRef: { current: DispatchInMount | null } = { current: null };
      const runtime = await GraphRuntime.mount(h(Connected, {}, mountRef));
      await Promise.resolve();
      await Promise.resolve();

      if (mountRef.current === null) {
        throw new Error('Dispatch-in-mount ref was not attached');
      }

      expect(mountRef.current.updateEvents).toEqual(['update:1']);

      await runtime.unmount();
      store.destroy();
    });

    test('state props override dispatch props when keys collide', () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'from-state',
        version: 0,
      });

      interface OverlapProps extends TestProps {
        sharedKey?: string | (() => void);
      }

      let dispatchSideCalled = false;

      class OverlapComponent extends Component<object, OverlapProps> {
        public seenSharedKey: unknown = undefined;

        public override onMount (): void {
          this.seenSharedKey = this.props.sharedKey;
        }
      }

      const Connected = connect<
        TestStoreState,
        OverlapProps,
        Pick<OverlapProps, 'sharedKey'>,
        TestAction
      >(
        store,
        (state: TestStoreState): Pick<OverlapProps, 'sharedKey'> => ({
          sharedKey: state.status,
        }),
        (): Pick<OverlapProps, 'sharedKey'> => ({
          sharedKey: (): void => {
            dispatchSideCalled = true;
          },
        }),
        { ownPropsModeMerge: true }
      )(OverlapComponent);

      const instance = new Connected({ id: 'overlap-key' }) as OverlapComponent;
      instance.onMount?.();

      expect(instance.seenSharedKey).toBe('from-state');
      expect(typeof instance.props.sharedKey).toBe('string');
      expect(dispatchSideCalled).toBe(false);

      instance.onUnmount?.();
    });

    test('root connected — IS_CONTEXT_PROVIDER and applyToScope publish store into the subtree', () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      class ScopeHost extends Component<object, Record<string, never>> {
        constructor (props: Record<string, never> = {}) {
          super(props);
          this.state = {};
        }
      }

      const ConnectedRoot = connect(store)(ScopeHost);
      const proto = ConnectedRoot.prototype as unknown as Record<symbol, unknown>;
      expect(proto[IS_CONTEXT_PROVIDER]).toBe(true);

      class ContextChild extends Component<object, TestProps> {
        constructor (props: TestProps) {
          super(props);
          this.state = {};
        }
      }

      const ConnectedChild = connect<
        TestStoreState,
        TestProps,
        Pick<TestProps, 'status'>
      >(
        (state: TestStoreState): Pick<TestProps, 'status'> => ({
          status: state.status,
        })
      )(ContextChild);

      const childFields = getContextFields(
        ConnectedChild as unknown as Parameters<typeof getContextFields>[0]
      );
      expect(childFields).toHaveLength(1);
      expect(childFields[0]?.propertyKey).toBe('__connectStoreFromContext');
      expect(childFields[0]?.token.displayName).toBe('EFFECTABLE_CONNECT_STORE');

      const rootInstance = new ConnectedRoot({}) as unknown as {
        applyToScope (parentScope: typeof EMPTY_CONTEXT_SCOPE): typeof EMPTY_CONTEXT_SCOPE;
      };
      const childScope = rootInstance.applyToScope(EMPTY_CONTEXT_SCOPE);
      const childProbe = new ConnectedChild({ id: 'scope-probe' });
      injectContextFields(childProbe, childScope);

      const storeFromScope = (childProbe as unknown as Record<string, unknown>)['__connectStoreFromContext'];
      expect(storeFromScope).toBe(store);
    });

    test('mapDispatch with a default props parameter — dispatch-only binding (props do not arrive)', () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      interface DefaultParamProps extends TestProps {
        emitStatusFromProps?: () => void;
      }

      function mapDispatchWithDefaultParam (
        dispatch: DispatchMethod<TestAction>,
        props: TestProps = { id: 'default-id' }
      ): Pick<DefaultParamProps, 'emitStatusFromProps'> {
        return {
          emitStatusFromProps: (): void => {
            dispatch({ type: 'SET_STATUS', payload: props.id });
          },
        };
      }

      expect(mapDispatchWithDefaultParam.length).toBe(1);

      class DefaultParamComponent extends Component<object, DefaultParamProps> {
        constructor (props: DefaultParamProps) {
          super(props);
          this.state = {};
        }
      }

      const Connected = connect<
        TestStoreState,
        DefaultParamProps,
        unknown,
        TestAction
      >(
        store,
        undefined,
        mapDispatchWithDefaultParam,
        { ownPropsModeMerge: true }
      )(DefaultParamComponent);

      const instance = new Connected({ id: 'real-own-id' }) as DefaultParamComponent;
      instance.onMount?.();
      instance.props.emitStatusFromProps?.();

      expect(store.getState().status).toBe('default-id');

      instance.onUnmount?.();
    });

    test('createStore + connect — dispatch changes state/props, after unmount emit does not update', async () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });
      const lifecycleEvents: string[] = [];

      interface StoreLifecycleProps extends TestProps {
        bump?: () => void;
      }

      class StoreLifecycleChild extends Component<object, StoreLifecycleProps> {
        public override onMount (): void {
          lifecycleEvents.push(`mount:${this.props.status ?? 'unknown'}`);
        }

        public override onUpdate (): void {
          lifecycleEvents.push(`update:${this.props.status ?? 'unknown'}`);
        }

        public override onUnmount (): void {
          lifecycleEvents.push('unmount');
        }
      }

      const ConnectedChild = connect<
        TestStoreState,
        StoreLifecycleProps,
        Pick<StoreLifecycleProps, 'status'>,
        TestAction
      >(
        (state: TestStoreState): Pick<StoreLifecycleProps, 'status'> => ({
          status: state.status,
        }),
        (dispatch: DispatchMethod<TestAction>): Pick<StoreLifecycleProps, 'bump'> => ({
          bump: (): void => {
            dispatch({ type: 'SET_STATUS', payload: 'via-dispatch-prop' });
          },
        })
      )(StoreLifecycleChild);

      class RootHost extends Component<object, Record<string, never>> {
        public override compose (): VirtualServiceNode[] {
          return [
            h(ConnectedChild, { id: 'store-lifecycle-child' }),
          ];
        }
      }

      const ConnectedRoot = connect(store)(RootHost);
      const runtime = await GraphRuntime.mount(h(ConnectedRoot, {}));
      await Promise.resolve();

      expect(lifecycleEvents).toEqual([
        'mount:idle',
        'update:idle',
      ]);

      store.dispatch({ type: 'SET_STATUS', payload: 'from-store' });
      await Promise.resolve();

      expect(lifecycleEvents).toEqual([
        'mount:idle',
        'update:idle',
        'update:from-store',
      ]);

      await runtime.unmount();

      store.dispatch({ type: 'SET_STATUS', payload: 'after-unmount' });
      await Promise.resolve();

      expect(lifecycleEvents).toEqual([
        'mount:idle',
        'update:idle',
        'update:from-store',
        'unmount',
      ]);

      store.destroy();
    });
  });

  describe('P0: ref-equal fast-exit and null store', () => {
    test('store emit with the same mapStateToProps reference does not call onUpdate (ref-equal fast-exit)', async () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'stable',
        version: 0,
      });

      const stableMapped: Pick<TestProps, 'status'> = { status: 'stable' };
      const updateEvents: string[] = [];

      class RefEqualComponent extends Component<TestComponentState, TestProps> {
        constructor (props: TestProps) {
          super(props);
          this.state = { localTick: 0 };
        }

        public override onUpdate (): void {
          updateEvents.push(`update:${this.props.status ?? 'unknown'}`);
        }
      }

      const Connected = connect<
        TestStoreState,
        TestProps,
        Pick<TestProps, 'status'>,
        TestAction
      >(
        store,
        (state: TestStoreState): Pick<TestProps, 'status'> => {
          if (state.status === 'stable') {
            return stableMapped;
          }

          return { status: state.status };
        }
      )(RefEqualComponent);

      const runtime = await GraphRuntime.mount(
        h(Connected, { id: 'ref-equal' })
      );

      await Promise.resolve();
      await Promise.resolve();
      const updatesAfterKickoff = updateEvents.length;

      store.dispatch({ type: 'SET_VERSION', payload: 1 });
      await Promise.resolve();
      store.dispatch({ type: 'SET_VERSION', payload: 2 });
      await Promise.resolve();

      expect(updateEvents.length).toBe(updatesAfterKickoff);

      store.dispatch({ type: 'SET_STATUS', payload: 'changed' });
      await Promise.resolve();
      await Promise.resolve();

      expect(updateEvents[updateEvents.length - 1]).toBe('update:changed');

      await runtime.unmount();
      store.destroy();
    });

    test('root connected without an explicit store (connect(mapState)) throws a store error', async () => {
      class RootWithoutStore extends Component<object, TestProps> {
        constructor (props: TestProps) {
          super(props);
          this.state = {};
        }
      }

      const ConnectedRoot = connect<
        TestStoreState,
        TestProps,
        Pick<TestProps, 'status'>
      >(
        (state: TestStoreState): Pick<TestProps, 'status'> => ({
          status: state.status,
        })
      )(RootWithoutStore);

      await expect(
        GraphRuntime.mount(h(ConnectedRoot, { id: 'no-store-root' }))
      ).rejects.toThrow('Store is not available');
    });
  });

  describe('P3: mapState null/array, root provider, reconcile without store, async unmount, HOC name', () => {
    test('mapState null is not applied to props and does not break mount', () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      class NullMapStateComponent extends Component<object, TestProps> {
        public seenStatus = 'missing';

        constructor (props: TestProps) {
          super(props);
          this.state = {};
        }

        public override onMount (): void {
          this.seenStatus = this.props.status ?? 'missing';
        }
      }

      const Connected = connect<TestStoreState, TestProps, unknown>(
        store,
        (): unknown => null,
        undefined,
        { ownPropsModeMerge: true }
      )(NullMapStateComponent);

      const instance = new Connected({ id: 'null-map-state' }) as NullMapStateComponent;
      instance.onMount?.();

      expect(instance.seenStatus).toBe('missing');
      expect(instance.props).toEqual({ id: 'null-map-state' });
      instance.onUnmount?.();
    });

    test('mapState array is not applied to props and does not break mount', () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      class ArrayMapStateComponent extends Component<object, TestProps> {
        public seenStatus = 'missing';

        constructor (props: TestProps) {
          super(props);
          this.state = {};
        }

        public override onMount (): void {
          this.seenStatus = this.props.status ?? 'missing';
        }
      }

      const Connected = connect<TestStoreState, TestProps, unknown>(
        store,
        (): unknown => ['not', 'props'],
        undefined,
        { ownPropsModeMerge: true }
      )(ArrayMapStateComponent);

      const instance = new Connected({ id: 'array-map-state' }) as ArrayMapStateComponent;
      instance.onMount?.();

      expect(instance.seenStatus).toBe('missing');
      expect(instance.props).toEqual({ id: 'array-map-state' });
      instance.onUnmount?.();
    });

    test('connect(store) root provider without mappers — mount and child receive store from context', async () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'from-store',
        version: 0,
      });

      let childSeenStatus = 'missing';

      class ProviderChild extends Component<object, TestProps> {
        constructor (props: TestProps) {
          super(props);
          this.state = {};
        }

        public override onMount (): void {
          childSeenStatus = this.props.status ?? 'missing';
        }
      }

      const ConnectedChild = connect<
        TestStoreState,
        TestProps,
        Pick<TestProps, 'status'>
      >(
        (state: TestStoreState): Pick<TestProps, 'status'> => ({
          status: state.status,
        })
      )(ProviderChild);

      class ProviderRoot extends Component<object, Record<string, never>> {
        public override compose (): VirtualServiceNode[] {
          return [
            h(ConnectedChild, { id: 'provider-child' }),
          ];
        }
      }

      const ConnectedRoot = connect(store)(ProviderRoot);
      const runtime = await GraphRuntime.mount(h(ConnectedRoot, {}));

      expect(childSeenStatus).toBe('from-store');

      await runtime.unmount();
      store.destroy();
    });

    test('RUNTIME_PROPS_RECEIVER when store is not yet resolved — only rebuildConnectProps', () => {
      interface ReconcileOwnProps extends TestProps {
        tag?: string;
      }

      class PreMountChild extends Component<object, ReconcileOwnProps> {
        public constructor (props: ReconcileOwnProps) {
          super(props);
          this.state = {};
        }
      }

      const ConnectedChild = connect<
        TestStoreState,
        ReconcileOwnProps,
        Pick<ReconcileOwnProps, 'status'>
      >(
        (state: TestStoreState): Pick<ReconcileOwnProps, 'status'> => ({
          status: state.status,
        }),
        undefined,
        { ownPropsModeMerge: true }
      )(PreMountChild);

      const instance = new ConnectedChild({
        id: 'before-reconcile',
        tag: 'alpha',
      }) as PreMountChild;

      const receiver = Reflect.get(instance, RUNTIME_PROPS_RECEIVER);
      if (typeof receiver !== 'function') {
        throw new Error('Expected RUNTIME_PROPS_RECEIVER on connected instance');
      }

      receiver.call(instance, { id: 'after-reconcile', tag: 'beta' });

      expect(instance.props).toEqual({
        id: 'after-reconcile',
        tag: 'beta',
      });
      expect(instance.props.status).toBeUndefined();
    });

    test('async super.onUnmount — Promise is forwarded from connected onUnmount', async () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      class AsyncUnmountHost extends Component<object, Record<string, never>> {
        public unmountCompleted = false;

        public constructor (props: Record<string, never> = {}) {
          super(props);
          this.state = {};
        }

        public override async onUnmount (): Promise<void> {
          await Promise.resolve();
          this.unmountCompleted = true;
        }
      }

      const Connected = connect(store)(AsyncUnmountHost);
      const instance = new Connected({}) as AsyncUnmountHost;
      instance.onMount?.();

      const unmountResult = instance.onUnmount?.();
      if (typeof unmountResult === 'undefined') {
        throw new Error('Expected onUnmount to return a Promise');
      }

      const unmountUnknown: unknown = unmountResult;
      if (
        typeof unmountUnknown !== 'object'
        || unmountUnknown === null
      ) {
        throw new Error('Expected async onUnmount to return a Promise');
      }

      const unmountRecord = unmountUnknown as Record<PropertyKey, unknown>;
      if (typeof unmountRecord['then'] !== 'function') {
        throw new Error('Expected async onUnmount to return a Promise');
      }

      await unmountResult;
      expect(instance.unmountCompleted).toBe(true);
      store.destroy();
    });

    test('connected HOC preserves Constructor.name of the wrapped class', () => {
      const store = createStore<TestStoreState, TestAction>(reducer, {
        status: 'idle',
        version: 0,
      });

      class PreservedNameHost extends Component<object, Record<string, never>> {
        public constructor (props: Record<string, never> = {}) {
          super(props);
          this.state = {};
        }
      }

      Object.defineProperty(PreservedNameHost, 'name', {
        value: 'PreservedNameHost',
        configurable: true,
      });

      const Connected = connect(store)(PreservedNameHost);
      expect(Connected.name).toBe('PreservedNameHost');
    });
  });
});
