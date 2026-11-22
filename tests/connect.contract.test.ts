/**
 * Host contract tests for `connect` (ProfitPop goal 29 HR-1…HR-10, G-M-1, idempotent onUnmount).
 *
 * Ported from ProfitPop `tests/effectable/connect.contract.test.ts` into the package
 * suite. Fakes exist only in this file; no host-app dependencies.
 *
 * @module Effectable/connect/contract.test
 */

import {
  Component,
  CONNECT_HOC_BRAND,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';
import type {
  ActionCreatorsMap,
  DispatchMethod,
  Store,
  VirtualServiceNode,
} from 'Effectable';
import { Observable } from 'rxjs';

const CONNECT_STORE_UNAVAILABLE_FRAGMENT = 'Store is not available';

const CONNECT_NESTED_HOC_ERROR_FRAGMENT = 'Cannot wrap an already-connected component';

const POST_MOUNT_SELECTOR_ERROR = 'POST_MOUNT_SELECTOR_ERROR';

const MOUNT_REJECTED = 'MOUNT_REJECTED';

const PROTO_BINDER_KEY = '__proto__';

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
  secret?: string;
  extra?: string;
  bumpVersion?: (value: number) => void;
}

interface TestComponentState {
  localTick: number;
}

interface RebindParentProps {
  childId: string;
  withExtra: boolean;
}

interface ConnectLifecycleTarget {
  onMount?: () => void | Promise<void>;
  onUnmount?: () => void | Promise<void>;
}

/**
 * Test store reducer.
 *
 * @param {TestStoreState} state - current state
 * @param {TestAction} action - scenario action
 * @returns {TestStoreState} next state
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
 * Creates a store with idle/0 initial state.
 *
 * @returns {Store<TestStoreState, TestAction>} scenario store
 */
function createTestStore (): Store<TestStoreState, TestAction> {
  return createStore<TestStoreState, TestAction>(reducer, {
    status: 'idle',
    version: 0,
  });
}

/**
 * Store wrapper: after `arm.armed` the next `select` emission errors without `next`.
 *
 * @param {Store<TestStoreState, TestAction>} base - live store
 * @param {{ armed: boolean }} arm - post-mount error flag
 * @returns {Store<TestStoreState, TestAction>} wrapper
 */
function wrapSelectErrorAfterArm (
  base: Store<TestStoreState, TestAction>,
  arm: { armed: boolean }
): Store<TestStoreState, TestAction> {
  const wrapped: Store<TestStoreState, TestAction> = {
    dispatch: (action) => {
      return base.dispatch(action);
    },
    getState: () => {
      return base.getState();
    },
    state$: base.state$,
    select: <T>(selectorFn: (state: TestStoreState) => T): Observable<T> => {
      return new Observable<T>((subscriber) => {
        const subscription = base.select(selectorFn).subscribe({
          next: (value: T): void => {
            if (arm.armed) {
              subscriber.error(new Error(POST_MOUNT_SELECTOR_ERROR));
              return;
            }
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
          subscription.unsubscribe();
        };
      });
    },
    destroy: (): void => {
      base.destroy();
    },
  };
  return wrapped;
}

/**
 * Waits for connect post-mount kick-off (two microtasks, same as package tests).
 *
 * @returns {Promise<void>}
 */
async function flushConnectKickoff (): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/**
 * Reads own-property `__proto__` on props without hitting the prototype getter.
 *
 * @param {object} props - public instance props
 * @returns {unknown} binder value, or undefined when the own property is absent
 */
function readOwnProtoBinder (props: object): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(props, PROTO_BINDER_KEY);
  if (descriptor === undefined) {
    return undefined;
  }
  return descriptor.value;
}

/**
 * Checks CONNECT_HOC_BRAND on a constructor.
 *
 * @param {Function} ctor - connected-class constructor
 * @returns {boolean} true when CONNECT_HOC_BRAND is own true
 */
function hasConnectHocBrand (ctor: Function): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(ctor, CONNECT_HOC_BRAND);
  if (descriptor === undefined) {
    return false;
  }
  return descriptor.value === true;
}

/**
 * Invokes a connect instance lifecycle hook; missing hook is a test error.
 *
 * @param {ConnectLifecycleTarget} instance - instance
 * @param {'onMount' | 'onUnmount'} hookName - hook name
 * @returns {void | Promise<void>} hook result
 */
function callConnectLifecycle (
  instance: ConnectLifecycleTarget,
  hookName: 'onMount' | 'onUnmount'
): void | Promise<void> {
  const hook = hookName === 'onMount' ? instance.onMount : instance.onUnmount;
  if (typeof hook !== 'function') {
    throw new Error(`expected ${hookName}`);
  }
  return hook.call(instance);
}

describe('connect Host contract (HR-1…HR-10)', () => {
  describe('lifecycle', () => {
    test('HR-7: first mapped-pass is visible in onMount before onUpdate', async () => {
      const store = createTestStore();
      const events: string[] = [];

      /**
       * Records lifecycle order into `events`.
       */
      class OrderProbeComponent extends Component<TestComponentState, TestProps> {
        /**
         * @param {TestProps} props - vnode props
         */
        constructor (props: TestProps) {
          super(props);
          this.state = { localTick: 0 };
        }

        /**
         * Records mapped status at mount.
         *
         * @returns {void}
         */
        public override onMount (): void {
          events.push(`mount:${this.props.status ?? 'missing'}`);
        }

        /**
         * Records mapped status at update.
         *
         * @returns {void}
         */
        public override onUpdate (): void {
          events.push(`update:${this.props.status ?? 'missing'}`);
        }
      }

      const Connected = connect(
        store,
        (state: TestStoreState): Pick<TestProps, 'status'> => {
          return { status: state.status };
        }
      )(OrderProbeComponent);

      const instance = new Connected({ id: 'order' });
      const mountResult = callConnectLifecycle(instance, 'onMount');
      if (mountResult !== undefined) {
        throw new Error('expected sync onMount');
      }
      expect(events[0]).toBe('mount:idle');
      expect(events.includes('update:idle')).toBe(false);
      await flushConnectKickoff();
      expect(events[1]).toBe('update:idle');
      callConnectLifecycle(instance, 'onUnmount');
      store.destroy();
    });

    test('HR-1: mapDispatch-only async onMount reject does not leave ACTIVE runtime', async () => {
      const store = createTestStore();

      /**
       * Component whose async onMount rejects.
       */
      class AsyncRejectComponent extends Component<TestComponentState, TestProps> {
        /**
         * @param {TestProps} props - vnode props
         */
        constructor (props: TestProps) {
          super(props);
          this.state = { localTick: 0 };
        }

        /**
         * Rejects mount.
         *
         * @returns {Promise<void>}
         * @throws {Error} MOUNT_REJECTED
         */
        public override async onMount (): Promise<void> {
          throw new Error(MOUNT_REJECTED);
        }
      }

      const Connected = connect(
        store,
        undefined,
        (dispatch: DispatchMethod<TestAction>): Pick<TestProps, 'bumpVersion'> => {
          return {
            bumpVersion: (value: number): void => {
              dispatch({ type: 'SET_VERSION', payload: value });
            },
          };
        }
      )(AsyncRejectComponent);

      await expect(GraphRuntime.mount(h(Connected, { id: 'async-reject' }))).rejects.toThrow(
        MOUNT_REJECTED
      );
      store.destroy();
    });
  });

  describe('mount / unmount / nested', () => {
    test('HR-8: child-connected node receives store from parent context', async () => {
      const store = createTestStore();
      let childStatus = 'missing';

      /**
       * Child node that reads mapped status.
       */
      class NestedChildComponent extends Component<TestComponentState, TestProps> {
        /**
         * @param {TestProps} props - vnode props
         */
        constructor (props: TestProps) {
          super(props);
          this.state = { localTick: 0 };
        }

        /**
         * Saves mapped status.
         *
         * @returns {void}
         */
        public override onMount (): void {
          childStatus = this.props.status ?? 'missing';
        }
      }

      const ConnectedChild = connect(
        (state: TestStoreState): Pick<TestProps, 'status'> => {
          return { status: state.status };
        }
      )(NestedChildComponent);

      /**
       * Root that publishes the store into the subtree.
       */
      class NestedParentComponent extends Component<TestComponentState, TestProps> {
        /**
         * @param {TestProps} props - vnode props
         */
        constructor (props: TestProps) {
          super(props);
          this.state = { localTick: 0 };
        }

        /**
         * Composes the connected child.
         *
         * @returns {VirtualServiceNode[]} tree
         */
        public override compose (): VirtualServiceNode[] {
          return [h(ConnectedChild, { id: 'child' })];
        }
      }

      const ConnectedParent = connect(store)(NestedParentComponent);
      const runtime = await GraphRuntime.mount(h(ConnectedParent, { id: 'parent' }));
      expect(childStatus).toBe('idle');
      await runtime.unmount();
      store.destroy();
    });

    test('HR-9: nested connected without a parent throws Store is not available', async () => {
      /**
       * Orphan without a connected ancestor.
       */
      class OrphanChildComponent extends Component<TestComponentState, TestProps> {
        /**
         * @param {TestProps} props - vnode props
         */
        constructor (props: TestProps) {
          super(props);
          this.state = { localTick: 0 };
        }
      }

      const ConnectedOrphan = connect(
        (state: TestStoreState): Pick<TestProps, 'status'> => {
          return { status: state.status };
        }
      )(OrphanChildComponent);

      /**
       * Plain parent without connect.
       */
      class PlainParentComponent extends Component<TestComponentState, Record<string, never>> {
        /**
         * @param {Record<string, never>} props - empty props
         */
        constructor (props: Record<string, never>) {
          super(props);
          this.state = { localTick: 0 };
        }

        /**
         * Mounts the orphan connected child.
         *
         * @returns {VirtualServiceNode[]} tree
         */
        public override compose (): VirtualServiceNode[] {
          return [h(ConnectedOrphan, { id: 'orphan' })];
        }
      }

      await expect(GraphRuntime.mount(h(PlainParentComponent))).rejects.toThrow(
        CONNECT_STORE_UNAVAILABLE_FRAGMENT
      );
    });

    test('repeated onUnmount is idempotent and unsubscribes the store', () => {
      const store = createTestStore();
      let unmountCount = 0;

      /**
       * Component with an onUnmount counter.
       */
      class UnmountProbeComponent extends Component<TestComponentState, TestProps> {
        /**
         * @param {TestProps} props - vnode props
         */
        constructor (props: TestProps) {
          super(props);
          this.state = { localTick: 0 };
        }

        /**
         * Increments the unmount counter.
         *
         * @returns {void}
         */
        public override onUnmount (): void {
          unmountCount += 1;
        }
      }

      const Connected = connect(
        store,
        (state: TestStoreState): Pick<TestProps, 'status'> => {
          return { status: state.status };
        }
      )(UnmountProbeComponent);

      const instance = new Connected({ id: 'unmount' });
      const mountResult = callConnectLifecycle(instance, 'onMount');
      if (mountResult !== undefined) {
        throw new Error('expected sync onMount');
      }
      const first = callConnectLifecycle(instance, 'onUnmount');
      const second = callConnectLifecycle(instance, 'onUnmount');
      if (first !== undefined || second !== undefined) {
        throw new Error('expected sync onUnmount');
      }
      expect(unmountCount).toBe(2);
      store.dispatch({ type: 'SET_STATUS', payload: 'after' });
      expect(instance.props.status).toBe('idle');
      store.destroy();
    });
  });

  describe('selectors', () => {
    test('HR-6: strict — own prop does not leak without a pass-through mapper', async () => {
      const store = createTestStore();
      let leaked = false;

      /**
       * Checks whether secret leaked into this.props.
       */
      class StrictProbeComponent extends Component<TestComponentState, TestProps> {
        /**
         * @param {TestProps} props - vnode props
         */
        constructor (props: TestProps) {
          super(props);
          this.state = { localTick: 0 };
        }

        /**
         * Records a secret leak.
         *
         * @returns {void}
         */
        public override onMount (): void {
          leaked = this.props.secret === 'leak';
        }
      }

      const Connected = connect(
        store,
        (state: TestStoreState): Pick<TestProps, 'status'> => {
          return { status: state.status };
        }
      )(StrictProbeComponent);

      const runtime = await GraphRuntime.mount(
        h(Connected, { id: 'strict', secret: 'leak' })
      );
      expect(leaked).toBe(false);
      await runtime.unmount();
      store.destroy();
    });

    test('HR-10: mapState object → null clears stale fields', () => {
      const store = createTestStore();
      let returnNull = false;

      /**
       * Reads status from mapped props.
       */
      class StaleClearComponent extends Component<TestComponentState, TestProps> {
        /**
         * @param {TestProps} props - vnode props
         */
        constructor (props: TestProps) {
          super(props);
          this.state = { localTick: 0 };
        }
      }

      const Connected = connect(
        store,
        (state: TestStoreState): Pick<TestProps, 'status'> | null => {
          if (returnNull) {
            return null;
          }
          return { status: state.status };
        }
      )(StaleClearComponent);

      const instance = new Connected({ id: 'stale' });
      const mountResult = callConnectLifecycle(instance, 'onMount');
      if (mountResult !== undefined) {
        throw new Error('expected sync onMount');
      }
      expect(instance.props.status).toBe('idle');
      returnNull = true;
      store.dispatch({ type: 'SET_VERSION', payload: 1 });
      expect(instance.props.status).toBeUndefined();
      callConnectLifecycle(instance, 'onUnmount');
      store.destroy();
    });
  });

  describe('dispatch', () => {
    test('HR-2: action-creator key __proto__ binds as an own-property', () => {
      const store = createTestStore();
      const creators: ActionCreatorsMap<TestAction> = {};
      Object.defineProperty(creators, PROTO_BINDER_KEY, {
        enumerable: true,
        configurable: true,
        writable: true,
        value: (): TestAction => {
          return { type: 'SET_STATUS', payload: 'from-proto' };
        },
      });

      /**
       * Empty connected component for object-form mapDispatch.
       */
      class ProtoBinderComponent extends Component<TestComponentState, TestProps> {
        public protoBinder: unknown = undefined;

        /**
         * @param {TestProps} props - vnode props
         */
        constructor (props: TestProps) {
          super(props);
          this.state = { localTick: 0 };
        }

        /**
         * Saves the own `__proto__` binder.
         *
         * @returns {void}
         */
        public override onMount (): void {
          this.protoBinder = readOwnProtoBinder(this.props);
        }
      }

      const Connected = connect(
        store,
        undefined,
        creators
      )(ProtoBinderComponent);

      const instance = new Connected({ id: 'proto' });
      const mountResult = callConnectLifecycle(instance, 'onMount');
      if (mountResult !== undefined) {
        throw new Error('expected sync onMount');
      }
      expect(Object.getPrototypeOf(instance.props) === Object.prototype).toBe(true);
      const binder = instance.protoBinder;
      if (typeof binder !== 'function') {
        throw new Error('expected __proto__ own dispatcher');
      }
      binder();
      expect(store.getState().status).toBe('from-proto');
      callConnectLifecycle(instance, 'onUnmount');
      store.destroy();
    });

    test('HR-5: mapDispatch that returns an array is ignored', () => {
      const store = createTestStore();

      /**
       * Records whether bumpVersion appeared.
       */
      class ArrayDispatchComponent extends Component<TestComponentState, TestProps> {
        public hasBump = false;

        /**
         * @param {TestProps} props - vnode props
         */
        constructor (props: TestProps) {
          super(props);
          this.state = { localTick: 0 };
        }

        /**
         * Checks that a dispatch prop from an array is absent.
         *
         * @returns {void}
         */
        public override onMount (): void {
          this.hasBump = typeof this.props.bumpVersion === 'function';
        }
      }

      const Connected = connect(
        store,
        undefined,
        (_dispatch: DispatchMethod<TestAction>): unknown[] => {
          return [];
        }
      )(ArrayDispatchComponent);

      const instance = new Connected({ id: 'array-dispatch' });
      const mountResult = callConnectLifecycle(instance, 'onMount');
      if (mountResult !== undefined) {
        throw new Error('expected sync onMount');
      }
      expect(instance.hasBump).toBe(false);
      callConnectLifecycle(instance, 'onUnmount');
      store.destroy();
    });
  });

  describe('errors / negative', () => {
    test('HR-4: connect(class Ext extends Connected) throws nested-HOC error', () => {
      const store = createTestStore();

      /**
       * Base for checking brand on the prototype chain.
       */
      class BaseComponent extends Component<TestComponentState, TestProps> {
        /**
         * @param {TestProps} props - vnode props
         */
        constructor (props: TestProps) {
          super(props);
          this.state = { localTick: 0 };
        }
      }

      const Connected = connect(store)(BaseComponent);
      expect(hasConnectHocBrand(Connected)).toBe(true);

      /**
       * Subclass of an already-connected constructor.
       */
      class Ext extends Connected {}

      expect(() => {
        connect(store)(Ext);
      }).toThrow(CONNECT_NESTED_HOC_ERROR_FRAGMENT);
      store.destroy();
    });

    test('HR-3: post-mount selector error does not crash the process and keeps last props', async () => {
      const base = createTestStore();
      const arm = { armed: false };
      const store = wrapSelectErrorAfterArm(base, arm);
      const events: string[] = [];
      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
      };
      process.on('unhandledRejection', onUnhandled);

      /**
       * Records status on each onUpdate.
       */
      class PostMountErrorComponent extends Component<TestComponentState, TestProps> {
        /**
         * @param {TestProps} props - vnode props
         */
        constructor (props: TestProps) {
          super(props);
          this.state = { localTick: 0 };
        }

        /**
         * Records status at mount.
         *
         * @returns {void}
         */
        public override onMount (): void {
          events.push(`mount:${this.props.status ?? 'missing'}`);
        }

        /**
         * Records status at update.
         *
         * @returns {void}
         */
        public override onUpdate (): void {
          events.push(`update:${this.props.status ?? 'missing'}`);
        }
      }

      const Connected = connect(
        store,
        (state: TestStoreState): Pick<TestProps, 'status'> => {
          return { status: state.status };
        }
      )(PostMountErrorComponent);

      try {
        const runtime = await GraphRuntime.mount(h(Connected, { id: 'post-error' }));
        await flushConnectKickoff();
        arm.armed = true;
        store.dispatch({ type: 'SET_STATUS', payload: 'live' });
        await flushConnectKickoff();
        expect(events[0]).toBe('mount:idle');
        expect(events.includes('update:live')).toBe(false);
        expect(unhandled.length).toBe(0);
        await runtime.unmount();
      } finally {
        process.off('unhandledRejection', onUnhandled);
        store.destroy();
      }
    });
  });

  describe('reconcile own-props', () => {
    test('G-M-1: different own-props length rebinds mapDispatch (shallowEqual length)', async () => {
      const store = createTestStore();
      const seenIds: string[] = [];

      /**
       * Child whose mapDispatch closes over own id.
       */
      class RebindChildComponent extends Component<TestComponentState, TestProps> {
        /**
         * @param {TestProps} props - vnode props
         */
        constructor (props: TestProps) {
          super(props);
          this.state = { localTick: 0 };
        }
      }

      const ConnectedChild = connect(
        undefined,
        (
          dispatch: DispatchMethod<TestAction>,
          props: TestProps
        ): Pick<TestProps, 'bumpVersion'> => {
          seenIds.push(props.id);
          return {
            bumpVersion: (value: number): void => {
              dispatch({ type: 'SET_VERSION', payload: value });
            },
          };
        }
      )(RebindChildComponent);

      /**
       * Root that changes the child own-props set.
       */
      class RebindParentComponent extends Component<TestComponentState, RebindParentProps> {
        /**
         * @param {RebindParentProps} props - child own-props flags
         */
        constructor (props: RebindParentProps) {
          super(props);
          this.state = { localTick: 0 };
        }

        /**
         * Composes the child with a different own-props key count.
         *
         * @returns {VirtualServiceNode[]} tree
         */
        public override compose (): VirtualServiceNode[] {
          if (this.props.withExtra) {
            return [
              h(ConnectedChild, {
                id: this.props.childId,
                extra: 'yes',
              }),
            ];
          }
          return [
            h(ConnectedChild, {
              id: this.props.childId,
            }),
          ];
        }
      }

      const ConnectedParent = connect(
        store,
        undefined,
        undefined,
        { ownPropsModeMerge: true }
      )(RebindParentComponent);

      const runtime = await GraphRuntime.mount(
        h(ConnectedParent, { childId: 'a', withExtra: false })
      );
      const before = seenIds.length;
      await runtime.reconcile(h(ConnectedParent, { childId: 'a', withExtra: true }));
      expect(seenIds.length).toBeGreaterThan(before);
      await runtime.unmount();
      store.destroy();
    });
  });
});
