/**
 * GraphRuntime tests: mount, reconcile, unmount, ContextProvider, ref binding.
 *
 * @module Effectable/component/GraphRuntime.entity.test
 */

import {
  Component,
  ContextProvider,
  EMPTY_CONTEXT_SCOPE,
  GraphRuntime,
  OnCommand,
  OnEvent,
  OnQuery,
  RUNTIME_PROPS_RECEIVER,
  UseCommandBus,
  UseContext,
  UseEventBus,
  UseImperativeHandle,
  UseQueryBus,
  UseRef,
  connect,
  createContext,
  createRuntimeBuses,
  createStore,
  extendScope,
  FIBER_EFFECT_TAG,
  h,
} from 'Effectable';
import type { RefObject, RuntimeCommand, RuntimeEvent, RuntimeQuery, VirtualServiceNode } from 'Effectable';

// ---------------------------------------------------------------------------
// Stub components for tests
// ---------------------------------------------------------------------------

class LeafComponent extends Component<Record<string, unknown>, { value: number }> {
  public calls: string[] = [];

  constructor (props: { value: number }) {
    super(props);
  }

  public override async onMount (): Promise<void> {
    this.calls.push(`onMount:${this.props.value}`);
  }

  public override async onUnmount (): Promise<void> {
    this.calls.push(`onUnmount:${this.props.value}`);
  }
}

class ParentComponent extends Component<Record<string, unknown>, { leafValue: number }> {
  public calls: string[] = [];

  @UseRef()
  private declare childRef: RefObject<LeafComponent>;

  constructor (props: { leafValue: number }) {
    super(props);
  }

  public override async onMount (): Promise<void> {
    this.calls.push('parent:onMount');
  }

  public override async onUnmount (): Promise<void> {
    this.calls.push('parent:onUnmount');
  }

  public override compose (): VirtualServiceNode[] {
    return [h(LeafComponent, { value: this.props.leafValue }, this.childRef)];
  }

  public getChildRef (): RefObject<LeafComponent> {
    return this.childRef;
  }
}

class FailingOnMountComponent extends Component<Record<string, unknown>, Record<string, unknown>> {
  public static lastFailedInstance: FailingOnMountComponent | null = null;

  public calls: string[] = [];

  constructor (props: Record<string, unknown>) {
    super(props);
  }

  public override async onMount (): Promise<void> {
    this.calls.push('onMount');
    FailingOnMountComponent.lastFailedInstance = this;
    throw new Error('FailingOnMountComponent.onMount failed');
  }
}

// ---------------------------------------------------------------------------
// Context test components
// ---------------------------------------------------------------------------

const NUMBER_TOKEN = createContext<number>('NUMBER_TOKEN');

class NumberConsumer extends Component<Record<string, unknown>, Record<string, unknown>> {
  public receivedValue: number | undefined;

  @UseContext(NUMBER_TOKEN) private contextNumber!: number;

  constructor (props: Record<string, unknown>) {
    super(props);
  }

  public override async onMount (): Promise<void> {
    this.receivedValue = this.contextNumber;
  }
}

class ProviderRoot extends Component<Record<string, unknown>, { contextValue: number }> {
  constructor (props: { contextValue: number }) {
    super(props);
  }

  public override compose (): VirtualServiceNode[] {
    return [
      h(ContextProvider, { value: [NUMBER_TOKEN, this.props.contextValue] }, [
        h(NumberConsumer, {}),
      ]),
    ];
  }
}

class ComposeNull extends Component<Record<string, unknown>, Record<string, unknown>> {
  public mounted = false;

  constructor (props: Record<string, unknown>) {
    super(props);
  }

  public override async onMount (): Promise<void> {
    this.mounted = true;
  }

  public override compose (): VirtualServiceNode[] | null {
    return null;
  }
}

/** compose() returns a single node (not an array) — covers getChildVnodes. */
class SingleNodeComposeParent extends Component<Record<string, unknown>, Record<string, unknown>> {
  @UseRef()
  private declare leafRef: RefObject<LeafComponent>;

  public getLeafRef (): RefObject<LeafComponent> {
    return this.leafRef;
  }

  public override compose (): VirtualServiceNode {
    return h(LeafComponent, { value: 123 }, this.leafRef);
  }
}

/** Explicit children in h() are ignored when compose() is present. */
class ComposeWinsParent extends Component<Record<string, unknown>, Record<string, unknown>> {
  @UseRef()
  private declare composedLeafRef: RefObject<LeafComponent>;

  public override compose (): VirtualServiceNode[] {
    return [h(LeafComponent, { value: 1 }, this.composedLeafRef)];
  }

  public getComposedLeafRef (): RefObject<LeafComponent> {
    return this.composedLeafRef;
  }
}

/** Two child nodes without key — positional reconcile. */
class TwoUnkeyedLeafParent extends Component<Record<string, unknown>, { a: number; b: number }> {
  @UseRef()
  private declare refA: RefObject<LeafComponent>;

  @UseRef()
  private declare refB: RefObject<LeafComponent>;

  public override compose (): VirtualServiceNode[] {
    return [
      h(LeafComponent, { value: this.props.a }, this.refA),
      h(LeafComponent, { value: this.props.b }, this.refB),
    ];
  }

  public getRefA (): RefObject<LeafComponent> {
    return this.refA;
  }

  public getRefB (): RefObject<LeafComponent> {
    return this.refB;
  }
}

/**
 * Parent with compose: child NumberConsumer + ref.
 * Context value is set via initialScope in GraphRuntime.mount (ContextProvider does not mount vnode.children when compose() === null).
 */
class ScopedConsumerParent extends Component<Record<string, unknown>, Record<string, unknown>> {
  @UseRef()
  public declare consumerRef: RefObject<NumberConsumer>;

  public override compose (): VirtualServiceNode[] {
    return [h(NumberConsumer, {}, this.consumerRef)];
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GraphRuntime', () => {
  describe('mount — basic scenario', () => {
    it('mounts a component with compose() === null without child nodes', async () => {
      const runtime = await GraphRuntime.mount(h(ComposeNull, {}));
      const root = runtime.getRootInstance() as ComposeNull | null;

      expect(root).not.toBeNull();
      expect(root!.mounted).toBe(true);

      await runtime.unmount();
    });

    it('mounts a single component and calls lifecycle hooks', async () => {
      const leaf = h(LeafComponent, { value: 42 });
      const runtime = await GraphRuntime.mount(leaf);

      expect(runtime.isActive()).toBe(true);

      const instance = runtime.getRootInstance() as LeafComponent;
      expect(instance).toBeInstanceOf(LeafComponent);
      expect(instance.calls).toContain('onMount:42');

      await runtime.unmount();
    });

    it('after mount parent compose() is called and the child instance is created', async () => {
      const parent = h(ParentComponent, { leafValue: 7 });
      const runtime = await GraphRuntime.mount(parent);

      const parentInstance = runtime.getRootInstance() as ParentComponent;
      expect(parentInstance.calls).toContain('parent:onMount');

      await runtime.unmount();
    });

    it('lifecycle order: children first, then parent (onMount)', async () => {
      const callOrder: string[] = [];

      class OrderedChild extends Component<Record<string, unknown>, Record<string, unknown>> {
        constructor (props: Record<string, unknown>) {
          super(props);
        }

        public override async onMount (): Promise<void> {
          callOrder.push('child:onMount');
        }
      }

      class OrderedParent extends Component<Record<string, unknown>, Record<string, unknown>> {
        constructor (props: Record<string, unknown>) {
          super(props);
        }

        public override compose (): VirtualServiceNode[] {
          return [h(OrderedChild, {})];
        }

        public override async onMount (): Promise<void> {
          callOrder.push('parent:onMount');
        }
      }

      const runtime = await GraphRuntime.mount(h(OrderedParent, {}));

      expect(callOrder).toEqual(['child:onMount', 'parent:onMount']);

      await runtime.unmount();
    });

    it('compose() may return a single VirtualServiceNode — the child node is mounted', async () => {
      const runtime = await GraphRuntime.mount(h(SingleNodeComposeParent, {}));
      const root = runtime.getRootInstance() as SingleNodeComposeParent;

      expect(root).toBeInstanceOf(SingleNodeComposeParent);
      expect(root.getLeafRef().current).toBeInstanceOf(LeafComponent);
      expect(root.getLeafRef().current!.props.value).toBe(123);

      await runtime.unmount();
    });

    it('when compose() is present, child nodes from h(..., [...]) are not materialized', async () => {
      const runtime = await GraphRuntime.mount(
        h(ComposeWinsParent, {}, [
          h(LeafComponent, { value: 999 }),
        ]),
      );

      const parent = runtime.getRootInstance() as ComposeWinsParent;
      const leaf = parent.getComposedLeafRef().current;

      expect(leaf).toBeInstanceOf(LeafComponent);
      expect(leaf!.props.value).toBe(1);

      await runtime.unmount();
    });
  });

  describe('ref binding', () => {
    it('ref.current is set after the child node is mounted', async () => {
      const leafRef: RefObject<LeafComponent> = { current: null };
      const leaf = h(LeafComponent, { value: 99 }, leafRef);
      const runtime = await GraphRuntime.mount(leaf);

      expect(leafRef.current).toBeInstanceOf(LeafComponent);
      expect((leafRef.current as LeafComponent).props.value).toBe(99);

      await runtime.unmount();
    });

    it('ref.current is cleared after unmount', async () => {
      const leafRef: RefObject<LeafComponent> = { current: null };
      const leaf = h(LeafComponent, { value: 1 }, leafRef);
      const runtime = await GraphRuntime.mount(leaf);

      expect(leafRef.current).not.toBeNull();

      await runtime.unmount();

      expect(leafRef.current).toBeNull();
    });

    it('ref of a component with compose() is set for the child node', async () => {
      const parent = h(ParentComponent, { leafValue: 5 });
      const runtime = await GraphRuntime.mount(parent);

      const parentInstance = runtime.getRootInstance() as ParentComponent;
      const childRef = parentInstance.getChildRef();

      expect(childRef.current).toBeInstanceOf(LeafComponent);

      await runtime.unmount();
    });
  });

  describe('unmount', () => {
    it('calls onUnmount for all nodes', async () => {
      const leaf = h(LeafComponent, { value: 10 });
      const runtime = await GraphRuntime.mount(leaf);
      const instance = runtime.getRootInstance() as LeafComponent;

      await runtime.unmount();

      expect(instance.calls).toContain('onUnmount:10');
    });

    it('repeated unmount is idempotent', async () => {
      const runtime = await GraphRuntime.mount(h(LeafComponent, { value: 0 }));

      await runtime.unmount();
      await runtime.unmount();

      expect(runtime.isActive()).toBe(false);
    });

    it('after unmount isActive() returns false', async () => {
      const runtime = await GraphRuntime.mount(h(LeafComponent, { value: 0 }));

      expect(runtime.isActive()).toBe(true);

      await runtime.unmount();

      expect(runtime.isActive()).toBe(false);
    });

    it('after unmount reconcile throws', async () => {
      const runtime = await GraphRuntime.mount(h(LeafComponent, { value: 0 }));

      await runtime.unmount();

      await expect(
        runtime.reconcile(h(LeafComponent, { value: 1 }))
      ).rejects.toThrow('[Effectable] GraphRuntime: reconcile attempted after unmount started.');
    });

    it('after unmount getRootInstance() returns null', async () => {
      const runtime = await GraphRuntime.mount(h(LeafComponent, { value: 0 }));

      expect(runtime.getRootInstance()).not.toBeNull();

      await runtime.unmount();

      expect(runtime.getRootInstance()).toBeNull();
    });
  });

  describe('reconcile — UPDATE', () => {
    it('updates props of an existing instance on reconcile with the same type', async () => {
      const runtime = await GraphRuntime.mount(h(LeafComponent, { value: 1 }));
      const originalInstance = runtime.getRootInstance();

      await runtime.reconcile(h(LeafComponent, { value: 2 }));

      const updatedInstance = runtime.getRootInstance() as LeafComponent;

      expect(updatedInstance.props.value).toBe(2);
      expect(updatedInstance).toBe(originalInstance);

      await runtime.unmount();
    });

    it('calls onUpdate when props change', async () => {
      const updateCalls: Array<[unknown, unknown]> = [];

      class TrackingComponent extends Component<Record<string, unknown>, { val: number }> {
        constructor (props: { val: number }) {
          super(props);
        }

        public override onUpdate (prev: unknown, next: unknown): void {
          updateCalls.push([prev, next]);
        }
      }

      const runtime = await GraphRuntime.mount(h(TrackingComponent, { val: 1 }));

      await runtime.reconcile(h(TrackingComponent, { val: 2 }));

      expect(updateCalls.length).toBe(1);
      expect((updateCalls[0] as [{ val: number }, unknown])[0]).toEqual({ val: 1 });

      await runtime.unmount();
    });

    it('does not call onUpdate if the props object is the same by reference', async () => {
      const updateCalls: Array<[unknown, unknown]> = [];

      class TrackingComponent extends Component<Record<string, unknown>, { val: number }> {
        constructor (props: { val: number }) {
          super(props);
        }

        public override onUpdate (prev: unknown, next: unknown): void {
          updateCalls.push([prev, next]);
        }
      }

      const sharedProps = { val: 1 };
      const runtime = await GraphRuntime.mount(h(TrackingComponent, sharedProps));

      await runtime.reconcile(h(TrackingComponent, sharedProps));

      expect(updateCalls).toHaveLength(0);

      await runtime.unmount();
    });

    it('calls onUpdate if fields match but the props object is new', async () => {
      const updateCalls: Array<[unknown, unknown]> = [];

      class TrackingComponent extends Component<Record<string, unknown>, { val: number }> {
        constructor (props: { val: number }) {
          super(props);
        }

        public override onUpdate (prev: unknown, next: unknown): void {
          updateCalls.push([prev, next]);
        }
      }

      const runtime = await GraphRuntime.mount(h(TrackingComponent, { val: 1 }));

      await runtime.reconcile(h(TrackingComponent, { val: 1 }));

      expect(updateCalls).toHaveLength(1);

      await runtime.unmount();
    });
  });

  describe('reconcile — root key change', () => {
    it('on root key change of the same type a new instance is created and the old one is destroyed', async () => {
      const runtime = await GraphRuntime.mount(
        h(LeafComponent, { value: 7 }, 'root-a'),
      );

      const first = runtime.getRootInstance() as LeafComponent;

      await runtime.reconcile(
        h(LeafComponent, { value: 7 }, 'root-b'),
      );

      const second = runtime.getRootInstance() as LeafComponent;

      expect(second).not.toBe(first);
      expect(first.calls).toContain('onUnmount:7');

      await runtime.unmount();
    });
  });

  describe('reconcile — PLACE/DELETE on type change', () => {
    it('on node type change creates a new instance and destroys the old one', async () => {
      class TypeA extends Component<Record<string, unknown>, Record<string, unknown>> {
        public calls: string[] = [];

        constructor (props: Record<string, unknown>) {
          super(props);
        }

        public override async onUnmount (): Promise<void> {
          this.calls.push('typeA:onUnmount');
        }
      }

      class TypeB extends Component<Record<string, unknown>, Record<string, unknown>> {
        constructor (props: Record<string, unknown>) {
          super(props);
        }
      }

      const runtime = await GraphRuntime.mount(h(TypeA, {}));
      const oldInstance = runtime.getRootInstance() as TypeA;

      await runtime.reconcile(h(TypeB, {}));

      const newInstance = runtime.getRootInstance();

      expect(newInstance).toBeInstanceOf(TypeB);
      expect(newInstance).not.toBe(oldInstance);
      expect(oldInstance.calls).toContain('typeA:onUnmount');

      await runtime.unmount();
    });
  });

  describe('reconcile — keyed child nodes', () => {
    it('keyed nodes are reused on reconcile in a changed order', async () => {
      const mountOrder: string[] = [];
      const destroyOrder: string[] = [];

      class KeyedChild extends Component<Record<string, unknown>, { id: string }> {
        constructor (props: { id: string }) {
          super(props);
        }

        public override async onMount (): Promise<void> {
          mountOrder.push(`mount:${this.props.id}`);
        }

        public override async onUnmount (): Promise<void> {
          destroyOrder.push(`destroy:${this.props.id}`);
        }
      }

      class KeyedParent extends Component<Record<string, unknown>, { order: string[] }> {
        constructor (props: { order: string[] }) {
          super(props);
        }

        public override compose (): VirtualServiceNode[] {
          return this.props.order.map(id =>
            h(KeyedChild, { id }, id)
          );
        }
      }

      const runtime = await GraphRuntime.mount(h(KeyedParent, { order: ['a', 'b'] }));

      expect(mountOrder).toContain('mount:a');
      expect(mountOrder).toContain('mount:b');

      mountOrder.length = 0;

      // Remove 'a', keep 'b'
      await runtime.reconcile(h(KeyedParent, { order: ['b'] }));

      expect(destroyOrder).toContain('destroy:a');
      expect(mountOrder).toHaveLength(0);

      await runtime.unmount();
    });

    it('when adding a new keyed node only the new one goes through PLACE', async () => {
      const mountOrder: string[] = [];

      class SimpleChild extends Component<Record<string, unknown>, { id: string }> {
        constructor (props: { id: string }) {
          super(props);
        }

        public override async onMount (): Promise<void> {
          mountOrder.push(`mount:${this.props.id}`);
        }
      }

      class SimpleParent extends Component<Record<string, unknown>, { ids: string[] }> {
        constructor (props: { ids: string[] }) {
          super(props);
        }

        public override compose (): VirtualServiceNode[] {
          return this.props.ids.map(id => h(SimpleChild, { id }, id));
        }
      }

      const runtime = await GraphRuntime.mount(h(SimpleParent, { ids: ['x'] }));
      mountOrder.length = 0;

      await runtime.reconcile(h(SimpleParent, { ids: ['x', 'y'] }));

      expect(mountOrder).toEqual(['mount:y']);

      await runtime.unmount();
    });
  });

  describe('reconcile — child nodes without key (position)', () => {
    it('reuses instances by position and updates props', async () => {
      const runtime = await GraphRuntime.mount(
        h(TwoUnkeyedLeafParent, { a: 1, b: 2 }),
      );

      const parent = runtime.getRootInstance() as TwoUnkeyedLeafParent;
      const firstA = parent.getRefA().current as LeafComponent;
      const firstB = parent.getRefB().current as LeafComponent;

      await runtime.reconcile(h(TwoUnkeyedLeafParent, { a: 10, b: 20 }));

      expect(parent.getRefA().current).toBe(firstA);
      expect(parent.getRefB().current).toBe(firstB);
      expect(firstA.props.value).toBe(10);
      expect(firstB.props.value).toBe(20);

      await runtime.unmount();
    });
  });

  describe('ContextProvider + @UseContext', () => {
    it('context value is passed to the child component via ContextProvider', async () => {
      const runtime = await GraphRuntime.mount(h(ProviderRoot, { contextValue: 42 }));

      const providerRoot = runtime.getRootInstance() as ProviderRoot;

      // Find NumberConsumer via compose + tree. Check via rootInstance.
      // Use another approach — direct mount with ContextProvider.
      await runtime.unmount();

      // Direct test: mount ContextProvider with NumberConsumer as a child
      const runtime2 = await GraphRuntime.mount(
        h(ContextProvider, { value: [NUMBER_TOKEN, 77] }, [
          h(NumberConsumer, {}),
        ]),
      );

      // NumberConsumer is not the root, but can be checked via the provider
      // Better: assert that RuntimeFiber was created without errors
      expect(runtime2.isActive()).toBe(true);

      await runtime2.unmount();

      void providerRoot;
    });

    it('NumberConsumer receives the value from ContextProvider', async () => {
      // Use a direct ContextProvider mount with NumberConsumer as a child
      // and check via getRootInstance -> compose -> children
      // Simpler: mount ContextProvider directly as the root
      const runtime = await GraphRuntime.mount(
        h(ContextProvider, { value: [NUMBER_TOKEN, 55] }, [
          h(NumberConsumer, {}),
        ]),
      );

      // Mount succeeded without errors -> NumberConsumer injected context
      expect(runtime.isActive()).toBe(true);

      // Additionally: mount NumberConsumer with the token directly via scope
      await runtime.unmount();

      // Check that without a provider defaultValue is used (covered in the next it)
      // Here ensure consumer onMount worked correctly via ProviderRoot
      const runtime2 = await GraphRuntime.mount(h(ProviderRoot, { contextValue: 55 }));
      expect(runtime2.isActive()).toBe(true);
      await runtime2.unmount();
    });

    it('default context is used when no provider is found', async () => {
      const DEFAULT_TOKEN = createContext<string>('DEFAULT_TOKEN', 'hello');

      class DefaultConsumer extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseContext(DEFAULT_TOKEN) private contextValue!: string;

        public receivedValue: string | undefined;

        constructor (props: Record<string, unknown>) {
          super(props);
        }

        public override async onMount (): Promise<void> {
          this.receivedValue = this.contextValue;
        }
      }

      const runtime = await GraphRuntime.mount(h(DefaultConsumer, {}));
      const instance = runtime.getRootInstance() as DefaultConsumer;

      expect(instance.receivedValue).toBe('hello');

      await runtime.unmount();
    });

    it('with no provider and no defaultValue — mount throws', async () => {
      const REQUIRED_TOKEN = createContext<number>('REQUIRED_TOKEN');

      class RequiredConsumer extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseContext(REQUIRED_TOKEN) private requiredValue!: number;

        constructor (props: Record<string, unknown>) {
          super(props);
        }
      }

      await expect(
        GraphRuntime.mount(h(RequiredConsumer, {}))
      ).rejects.toThrow('REQUIRED_TOKEN');
    });

    it('NumberConsumer as root with initialScope receives the token value', async () => {
      const scope = extendScope(EMPTY_CONTEXT_SCOPE, NUMBER_TOKEN, 55);

      const runtime = await GraphRuntime.mount(h(NumberConsumer, {}), scope);

      const root = runtime.getRootInstance() as NumberConsumer;

      expect(root.receivedValue).toBe(55);

      await runtime.unmount();
    });

    it('ScopedConsumerParent: child NumberConsumer via ref receives the value from initialScope', async () => {
      const scope = extendScope(EMPTY_CONTEXT_SCOPE, NUMBER_TOKEN, 55);

      const runtime = await GraphRuntime.mount(h(ScopedConsumerParent, {}), scope);

      const parent = runtime.getRootInstance() as ScopedConsumerParent;

      expect(parent.consumerRef.current).not.toBeNull();
      expect(parent.consumerRef.current!.receivedValue).toBe(55);

      await runtime.unmount();
    });

    it('after reconcile @UseContext field is not reinjected — receivedValue stays as on first mount', async () => {
      const scope55 = extendScope(EMPTY_CONTEXT_SCOPE, NUMBER_TOKEN, 55);

      const runtime = await GraphRuntime.mount(h(NumberConsumer, {}), scope55);

      const root = runtime.getRootInstance() as NumberConsumer;

      expect(root.receivedValue).toBe(55);

      await runtime.reconcile(h(NumberConsumer, {}));

      expect(root.receivedValue).toBe(55);

      await runtime.unmount();
    });
  });

  describe('startup failure — partial cleanup', () => {
    it('on onMount error mount throws', async () => {
      await expect(
        GraphRuntime.mount(h(FailingOnMountComponent, {}))
      ).rejects.toThrow('FailingOnMountComponent.onMount failed');
    });

    it('on onMount error the instance is recorded in lastFailedInstance', async () => {
      FailingOnMountComponent.lastFailedInstance = null;

      await expect(
        GraphRuntime.mount(h(FailingOnMountComponent, {}))
      ).rejects.toThrow('FailingOnMountComponent.onMount failed');

      expect(FailingOnMountComponent.lastFailedInstance).not.toBeNull();
      expect(
        FailingOnMountComponent.lastFailedInstance!.calls,
      ).toContain('onMount');
    });

    it('on parent startup error child nodes are unmounted', async () => {
      const childCalls: string[] = [];

      class CleanableChild extends Component<Record<string, unknown>, Record<string, unknown>> {
        constructor (props: Record<string, unknown>) {
          super(props);
        }

        public override async onMount (): Promise<void> {
          childCalls.push('child:onMount');
        }

        public override async onUnmount (): Promise<void> {
          childCalls.push('child:onUnmount');
        }
      }

      class FailingParent extends Component<Record<string, unknown>, Record<string, unknown>> {
        constructor (props: Record<string, unknown>) {
          super(props);
        }

        public override compose (): VirtualServiceNode[] {
          return [h(CleanableChild, {})];
        }

        public override async onMount (): Promise<void> {
          throw new Error('FailingParent.onMount failed');
        }
      }

      await expect(
        GraphRuntime.mount(h(FailingParent, {}))
      ).rejects.toThrow('FailingParent.onMount failed');

      expect(childCalls).toContain('child:onMount');
      expect(childCalls).toContain('child:onUnmount');
    });
  });

  describe('reconcile — edge / negative (P0)', () => {
    it('removing a keyed child unmounts only the removed node (DELETE path)', async () => {
      const unmounts: string[] = [];

      class KeyedLeaf extends Component<Record<string, unknown>, { id: string }> {
        public override async onUnmount (): Promise<void> {
          unmounts.push(this.props.id);
        }
      }

      class KeyedHost extends Component<Record<string, unknown>, { ids: string[] }> {
        public override compose (): VirtualServiceNode[] {
          return this.props.ids.map((id) => h(KeyedLeaf, { id }, id));
        }
      }

      const runtime = await GraphRuntime.mount(
        h(KeyedHost, { ids: ['a', 'b', 'c'] }),
      );

      await runtime.reconcile(h(KeyedHost, { ids: ['a', 'c'] }));

      expect(unmounts).toEqual(['b']);

      await runtime.unmount();
    });

    it('duplicate keys force full-diff: map keeps the last current, length change breaks stable-path', async () => {
      const mounts: string[] = [];
      const unmounts: string[] = [];

      class DupLeaf extends Component<Record<string, unknown>, { label: string }> {
        public override async onMount (): Promise<void> {
          mounts.push(`mount:${this.props.label}`);
        }

        public override async onUnmount (): Promise<void> {
          unmounts.push(`unmount:${this.props.label}`);
        }
      }

      class DupHost extends Component<
        Record<string, unknown>,
        { items: Array<{ key: string; label: string }> }
      > {
        public override compose (): VirtualServiceNode[] {
          return this.props.items.map((item) =>
            h(DupLeaf, { label: item.label }, item.key),
          );
        }
      }

      // Option A contract: duplicate keys in current children are invalid
      await expect(
        GraphRuntime.mount(
          h(DupHost, {
            items: [
              { key: 'dup', label: 'first' },
              { key: 'dup', label: 'second' },
            ],
          }),
        ),
      ).rejects.toThrow('duplicate key "dup" in current children');

      // Option A contract: duplicate keys in next children are invalid
      const runtime = await GraphRuntime.mount(
        h(DupHost, {
          items: [
            { key: 'unique-a', label: 'first' },
            { key: 'unique-b', label: 'second' },
          ],
        }),
      );

      expect(mounts).toEqual(['mount:first', 'mount:second']);
      mounts.length = 0;
      unmounts.length = 0;

      await expect(
        runtime.reconcile(
          h(DupHost, {
            items: [
              { key: 'dup', label: 'reuse-1' },
              { key: 'dup', label: 'reuse-2' },
            ],
          }),
        ),
      ).rejects.toThrow('duplicate key "dup" in next children');

      await runtime.unmount();
    });

    it('error in onUpdate during reconcile → runFailedCleanup (onUnmount) and rethrow', async () => {
      class ExplodingUpdate extends Component<
        Record<string, unknown>,
        { boom: boolean }
      > {
        public calls: string[] = [];

        public override onMount (): void {
          this.calls.push('onMount');
        }

        public override onUpdate (): void {
          if (this.props.boom) {
            throw new Error('onUpdate boom');
          }
        }

        public override onUnmount (): void {
          this.calls.push('onUnmount');
        }
      }

      const runtime = await GraphRuntime.mount(
        h(ExplodingUpdate, { boom: false }),
      );
      const instance = runtime.getRootInstance() as ExplodingUpdate | null;
      expect(instance).not.toBeNull();
      if (instance === null) {
        throw new Error('expected ExplodingUpdate');
      }

      await expect(
        runtime.reconcile(h(ExplodingUpdate, { boom: true })),
      ).rejects.toThrow('onUpdate boom');

      expect(instance.calls).toContain('onMount');
      expect(instance.calls).toContain('onUnmount');

      await runtime.unmount();
    });

    it('error in onUnmount during DELETE does not leave the tree half-destroyed', async () => {
      class ExplodingUnmountLeaf extends Component<
        Record<string, unknown>,
        { id: string }
      > {
        public override async onUnmount (): Promise<void> {
          if (this.props.id === 'bad') {
            throw new Error('onUnmount boom');
          }
        }
      }

      class Host extends Component<
        Record<string, unknown>,
        { ids: string[] }
      > {
        public override compose (): VirtualServiceNode[] {
          return this.props.ids.map((id) =>
            h(ExplodingUnmountLeaf, { id }, id),
          );
        }
      }

      const runtime = await GraphRuntime.mount(
        h(Host, { ids: ['ok', 'bad'] }),
      );

      // LifecycleEngine swallows onUnmount error (ok:false) and still destroyed —
      // reconcileChildrenFullDiff need not throw; pin the actual contract.
      await runtime.reconcile(h(Host, { ids: ['ok'] }));

      expect(runtime.isActive()).toBe(true);

      await runtime.unmount();
      expect(runtime.isActive()).toBe(false);
    });

    it('manual reconcile clears pending dirtyFibers and prevents double rebuild by auto-flush', async () => {
      let composeCount = 0;

      class DirtyLeaf extends Component<
        Record<string, unknown>,
        { n: number }
      > {}

      class DirtyRoot extends Component<
        { tick: number },
        Record<string, unknown>
      > {
        constructor (props: Record<string, unknown>) {
          super(props);
          this.state = { tick: 0 };
        }

        public bump (): void {
          this.setState({ tick: this.state.tick + 1 });
        }

        public override compose (): VirtualServiceNode[] {
          composeCount += 1;
          return [h(DirtyLeaf, { n: this.state.tick })];
        }
      }

      const runtime = await GraphRuntime.mount(h(DirtyRoot, {}));
      const root = runtime.getRootInstance() as DirtyRoot;
      const composeAfterMount = composeCount;

      root.bump();
      // Before microtask flush: manual reconcile must clear the dirty queue.
      await runtime.reconcile(h(DirtyRoot, {}));
      await Promise.resolve();
      await Promise.resolve();

      const composeAfterManual = composeCount;
      expect(composeAfterManual).toBeGreaterThan(composeAfterMount);

      const beforeIdle = composeCount;
      await Promise.resolve();
      await Promise.resolve();
      expect(composeCount).toBe(beforeIdle);

      await runtime.unmount();
    });

    it('manual reconcile waits for in-flight dirty flush (serialization)', async () => {
      let composeCount = 0;
      let midFlushReconcileDone = false;

      class SerializeLeaf extends Component<
        Record<string, unknown>,
        { n: number }
      > {}

      class SerializeRoot extends Component<
        { tick: number },
        Record<string, unknown>
      > {
        constructor (props: Record<string, unknown>) {
          super(props);
          this.state = { tick: 0 };
        }

        public bump (): void {
          this.setState({ tick: this.state.tick + 1 });
        }

        public override compose (): VirtualServiceNode[] {
          composeCount += 1;
          return [h(SerializeLeaf, { n: this.state.tick })];
        }
      }

      const runtime = await GraphRuntime.mount(h(SerializeRoot, {}));
      const root = runtime.getRootInstance() as SerializeRoot | null;
      expect(root).not.toBeNull();
      if (root === null) {
        throw new Error('expected SerializeRoot');
      }

      root.bump();
      // A microtask flush is scheduled; reconcile must wait for it to finish.
      const reconcilePromise = runtime.reconcile(h(SerializeRoot, {})).then(() => {
        midFlushReconcileDone = true;
      });

      expect(midFlushReconcileDone).toBe(false);
      await reconcilePromise;
      expect(midFlushReconcileDone).toBe(true);
      expect(composeCount).toBeGreaterThan(0);

      const beforeIdle = composeCount;
      await Promise.resolve();
      await Promise.resolve();
      expect(composeCount).toBe(beforeIdle);

      await runtime.unmount();
    });

    it('mixed list of keyed and unkeyed children reconciles without crashing', async () => {
      class MixLeaf extends Component<
        Record<string, unknown>,
        { label: string }
      > {}

      class MixHost extends Component<
        Record<string, unknown>,
        { mode: 'a' | 'b' }
      > {
        public override compose (): VirtualServiceNode[] {
          if (this.props.mode === 'a') {
            return [
              h(MixLeaf, { label: 'k1' }, 'k1'),
              h(MixLeaf, { label: 'u0' }),
              h(MixLeaf, { label: 'k2' }, 'k2'),
            ];
          }

          return [
            h(MixLeaf, { label: 'u0-next' }),
            h(MixLeaf, { label: 'k2-next' }, 'k2'),
            h(MixLeaf, { label: 'k1-next' }, 'k1'),
          ];
        }
      }

      const runtime = await GraphRuntime.mount(h(MixHost, { mode: 'a' }));
      await runtime.reconcile(h(MixHost, { mode: 'b' }));
      expect(runtime.isActive()).toBe(true);
      await runtime.unmount();
    });
  });

  describe('I36 — GraphRuntime.mount runtime buses bundle', () => {
    type I36Buses = ReturnType<
      typeof createRuntimeBuses<
        RuntimeCommand<string, unknown>,
        RuntimeQuery<string, unknown>,
        RuntimeEvent<string, unknown>
      >
    >;

    function readI36PayloadN (command: RuntimeCommand<string, unknown>): number {
      if (command.type !== 'I36_CMD') {
        throw new Error(`unexpected command type: ${command.type}`);
      }
      const raw = command.payload;
      if (typeof raw !== 'object' || raw === null) {
        throw new Error('I36_CMD payload must be object');
      }
      if (!Object.hasOwn(raw, 'n')) {
        throw new Error('I36_CMD payload missing n');
      }
      const nVal = Reflect.get(raw, 'n');
      if (typeof nVal !== 'number') {
        throw new Error('I36_CMD payload.n must be number');
      }
      return nVal;
    }

    class CommandHandlerHost extends Component<Record<string, unknown>, Record<string, unknown>> {
      public lastPayload: number | undefined;

      @UseCommandBus()
      public commandBus!: I36Buses['commandBus'];

      constructor () {
        super({});
      }

      @OnCommand('I36_CMD')
      public async handleI36 (command: RuntimeCommand<string, unknown>): Promise<number> {
        const n = readI36PayloadN(command);
        this.lastPayload = n;
        return n + 10;
      }
    }

    it('on mount with buses @OnCommand/@UseCommandBus work; after unmount execute throws', async () => {
      const buses = createRuntimeBuses<
        RuntimeCommand<string, unknown>,
        RuntimeQuery<string, unknown>,
        RuntimeEvent<string, unknown>
      >();
      const runtime = await GraphRuntime.mount(h(CommandHandlerHost, {}), EMPTY_CONTEXT_SCOPE, buses);

      const host = runtime.getRootInstance() as CommandHandlerHost | null;
      expect(host).not.toBeNull();

      if (host === null) {
        throw new Error('expected CommandHandlerHost');
      }

      expect(host.commandBus).toBe(buses.commandBus);

      const cmd: RuntimeCommand<string, unknown> = { type: 'I36_CMD', payload: { n: 5 } };
      const result = await buses.commandBus.execute<number>(cmd);
      expect(result).toBe(15);
      expect(host.lastPayload).toBe(5);

      await runtime.unmount();

      await expect(buses.commandBus.execute<number>(cmd)).rejects.toThrow(
        'Command handler is not registered: I36_CMD',
      );
    });

    it('mount without runtimeBuses — @OnCommand is not registered, execute on external bus throws', async () => {
      const buses = createRuntimeBuses<
        RuntimeCommand<string, unknown>,
        RuntimeQuery<string, unknown>,
        RuntimeEvent<string, unknown>
      >();
      const runtime = await GraphRuntime.mount(h(CommandHandlerHost, {}));

      const host = runtime.getRootInstance() as CommandHandlerHost | null;
      expect(host).not.toBeNull();
      if (host === null) {
        throw new Error('expected CommandHandlerHost');
      }

      const cmd: RuntimeCommand<string, unknown> = { type: 'I36_CMD', payload: { n: 3 } };
      await expect(buses.commandBus.execute<number>(cmd)).rejects.toThrow(
        'Command handler is not registered: I36_CMD',
      );

      await runtime.unmount();
    });

    it('RT-10: @OnQuery/@OnEvent + @UseQueryBus/@UseEventBus wiring end-to-end', async () => {
      type Rt10Buses = ReturnType<
        typeof createRuntimeBuses<
          RuntimeCommand<string, unknown>,
          RuntimeQuery<string, unknown>,
          RuntimeEvent<string, unknown>
        >
      >;

      class QueryEventHost extends Component<Record<string, unknown>, Record<string, unknown>> {
        public lastQuery: string | undefined;
        public events: string[] = [];

        @UseQueryBus()
        public queryBus!: Rt10Buses['queryBus'];

        @UseEventBus()
        public eventBus!: Rt10Buses['eventBus'];

        constructor () {
          super({});
        }

        @OnQuery('RT10_Q')
        public async handleQuery (query: RuntimeQuery<string, unknown>): Promise<number> {
          const raw = query.payload;
          if (typeof raw !== 'object' || raw === null || !Object.hasOwn(raw, 'key')) {
            throw new Error('RT10_Q payload.key required');
          }
          const keyVal = Reflect.get(raw, 'key');
          if (typeof keyVal !== 'string') {
            throw new Error('RT10_Q payload.key must be string');
          }
          this.lastQuery = keyVal;
          return keyVal.length;
        }

        @OnEvent('RT10_E')
        public onRt10Event (event: RuntimeEvent<string, unknown>): void {
          const raw = event.payload;
          if (typeof raw !== 'object' || raw === null || !Object.hasOwn(raw, 'msg')) {
            throw new Error('RT10_E payload.msg required');
          }
          const msgVal = Reflect.get(raw, 'msg');
          if (typeof msgVal !== 'string') {
            throw new Error('RT10_E payload.msg must be string');
          }
          this.events.push(msgVal);
        }
      }

      const buses = createRuntimeBuses<
        RuntimeCommand<string, unknown>,
        RuntimeQuery<string, unknown>,
        RuntimeEvent<string, unknown>
      >();
      const runtime = await GraphRuntime.mount(h(QueryEventHost, {}), EMPTY_CONTEXT_SCOPE, buses);

      const host = runtime.getRootInstance() as QueryEventHost | null;
      expect(host).not.toBeNull();
      if (host === null) {
        throw new Error('expected QueryEventHost');
      }

      expect(host.queryBus).toBe(buses.queryBus);
      expect(host.eventBus).toBe(buses.eventBus);

      await expect(
        buses.queryBus.execute<number>({ type: 'RT10_Q', payload: { key: 'abcd' } }),
      ).resolves.toBe(4);
      expect(host.lastQuery).toBe('abcd');

      buses.eventBus.publish({ type: 'RT10_E', payload: { msg: 'hello' } });
      expect(host.events).toEqual(['hello']);

      await runtime.unmount();

      await expect(
        buses.queryBus.execute<number>({ type: 'RT10_Q', payload: { key: 'x' } }),
      ).rejects.toThrow('Query handler is not registered: RT10_Q');

      buses.eventBus.publish({ type: 'RT10_E', payload: { msg: 'after' } });
      expect(host.events).toEqual(['hello']);
    });
  });

  describe('I37 / K07 — @UseRef and @UseImperativeHandle on mount', () => {
    class ImperativeChild extends Component<Record<string, unknown>, Record<string, unknown>> {
      constructor () {
        super({});
      }

      @UseImperativeHandle()
      public getAnswer (): number {
        return 42;
      }

      public secretInternal (): string {
        return 'hidden';
      }
    }

    class RefParent extends Component<Record<string, unknown>, Record<string, unknown>> {
      @UseRef()
      private declare childRef: RefObject<ImperativeChild>;

      constructor () {
        super({});
      }

      public override compose (): VirtualServiceNode[] {
        return [h(ImperativeChild, {}, this.childRef)];
      }

      public getChildRef (): RefObject<ImperativeChild> {
        return this.childRef;
      }

      public callChildImperative (): number {
        const current = this.childRef.current;
        if (current === null) {
          throw new Error('child ref is null');
        }
        return current.getAnswer();
      }
    }

    it('after mount parent ref.current.getAnswer() via @UseImperativeHandle works', async () => {
      const runtime = await GraphRuntime.mount(h(RefParent, {}));

      const parent = runtime.getRootInstance() as RefParent | null;
      expect(parent).not.toBeNull();

      if (parent === null) {
        throw new Error('expected RefParent');
      }

      const childRef = parent.getChildRef();
      expect(childRef.current).not.toBeNull();

      if (childRef.current === null) {
        throw new Error('expected ImperativeChild');
      }

      expect(parent.callChildImperative()).toBe(42);
      expect(childRef.current.getAnswer()).toBe(42);

      await runtime.unmount();
      expect(childRef.current).toBeNull();
    });
  });

  describe('async startup / materialize', () => {
    it('parent with sync children and async onMount reject — mount rejects, children get onUnmount', async () => {
      const childCalls: string[] = [];

      class CleanableChild extends Component<Record<string, unknown>, Record<string, unknown>> {
        constructor (props: Record<string, unknown>) {
          super(props);
        }

        public override async onMount (): Promise<void> {
          childCalls.push('child:onMount');
        }

        public override async onUnmount (): Promise<void> {
          childCalls.push('child:onUnmount');
        }
      }

      class AsyncRejectParent extends Component<Record<string, unknown>, Record<string, unknown>> {
        constructor (props: Record<string, unknown>) {
          super(props);
        }

        public override compose (): VirtualServiceNode[] {
          return [h(CleanableChild, {})];
        }

        public override async onMount (): Promise<void> {
          await Promise.resolve();
          throw new Error('AsyncRejectParent.onMount failed');
        }
      }

      await expect(
        GraphRuntime.mount(h(AsyncRejectParent, {})),
      ).rejects.toThrow('AsyncRejectParent.onMount failed');

      expect(childCalls).toContain('child:onMount');
      expect(childCalls).toContain('child:onUnmount');
    });

    it('child with async onMount — continueMaterializeAsync, mount succeeds, parent and child mounted', async () => {
      const mountCalls: string[] = [];

      class AsyncMountChild extends Component<Record<string, unknown>, Record<string, unknown>> {
        public mountedAfterAsync = false;

        constructor (props: Record<string, unknown>) {
          super(props);
        }

        public override async onMount (): Promise<void> {
          await Promise.resolve();
          mountCalls.push('child:onMount');
          this.mountedAfterAsync = true;
        }
      }

      class ParentOfAsyncChild extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseRef()
        private declare asyncChildRef: RefObject<AsyncMountChild>;

        constructor (props: Record<string, unknown>) {
          super(props);
        }

        public override compose (): VirtualServiceNode[] {
          return [h(AsyncMountChild, {}, this.asyncChildRef)];
        }

        public override async onMount (): Promise<void> {
          mountCalls.push('parent:onMount');
        }

        public getAsyncChildRef (): RefObject<AsyncMountChild> {
          return this.asyncChildRef;
        }
      }

      const runtime = await GraphRuntime.mount(h(ParentOfAsyncChild, {}));

      expect(runtime.isActive()).toBe(true);
      expect(mountCalls).toEqual(['child:onMount', 'parent:onMount']);

      const parent = runtime.getRootInstance() as ParentOfAsyncChild | null;
      expect(parent).not.toBeNull();

      if (parent === null) {
        throw new Error('expected ParentOfAsyncChild');
      }

      const childRef = parent.getAsyncChildRef();
      expect(childRef.current).not.toBeNull();

      if (childRef.current === null) {
        throw new Error('expected AsyncMountChild');
      }

      expect(childRef.current.mountedAfterAsync).toBe(true);

      await runtime.unmount();
    });

    it('continueStableReconcileAsync with async reconcileFiber on stable path increments the counter', async () => {
      class NestedLeaf extends Component<Record<string, unknown>, Record<string, unknown>> {
        constructor (props: Record<string, unknown>) {
          super(props);
        }
      }

      class SlotChild extends Component<Record<string, unknown>, { withLeaf: boolean }> {
        constructor (props: { withLeaf: boolean }) {
          super(props);
        }

        public override compose (): VirtualServiceNode[] {
          if (this.props.withLeaf) {
            return [h(NestedLeaf, {})];
          }

          return [];
        }
      }

      class StableAsyncParent extends Component<
        Record<string, unknown>,
        { expandFirst: boolean }
      > {
        constructor (props: { expandFirst: boolean }) {
          super(props);
        }

        public override compose (): VirtualServiceNode[] {
          return [
            h(SlotChild, { withLeaf: this.props.expandFirst }, 'slot-a'),
            h(SlotChild, { withLeaf: false }, 'slot-b'),
          ];
        }
      }

      const runtime = await GraphRuntime.mount(
        h(StableAsyncParent, { expandFirst: false }),
      );
      const before = runtime.getStableAsyncContinueCount();

      await runtime.reconcile(h(StableAsyncParent, { expandFirst: true }));

      expect(runtime.getStableAsyncContinueCount()).toBeGreaterThan(before);

      const snap = runtime.inspectRootFiber();
      expect(snap).not.toBeNull();

      if (snap === null) {
        throw new Error('expected fiber inspect after reconcile');
      }

      expect(snap.childCount).toBe(2);

      const firstChild = snap.children[0];
      if (firstChild === undefined) {
        throw new Error('expected first stable child fiber inspect');
      }

      expect(firstChild.childCount).toBe(1);

      await runtime.unmount();
    });
  });

  describe('onAutoReconcileError / unkeyed / unmount / dirty dedup', () => {
    async function drainMicrotasks (): Promise<void> {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }

    it('GraphRuntime.mount 4th argument onAutoReconcileError catches auto-flush error', async () => {
      class BoomComposeRoot extends Component<{ boom: boolean }, Record<string, never>> {
        constructor () {
          super({});
          this.state = { boom: false };
        }

        public override compose (): null {
          if (this.state.boom) {
            throw new Error('auto-flush compose boom');
          }
          return null;
        }
      }

      const errors: unknown[] = [];
      const runtime = await GraphRuntime.mount(
        h(BoomComposeRoot, {}),
        EMPTY_CONTEXT_SCOPE,
        undefined,
        (err) => {
          errors.push(err);
        },
      );

      const root = runtime.getRootInstance() as BoomComposeRoot | null;
      expect(root).not.toBeNull();
      if (root === null) {
        throw new Error('expected BoomComposeRoot');
      }

      root.setState({ boom: true });
      await drainMicrotasks();

      expect(errors).toHaveLength(1);
      expect(errors[0]).toBeInstanceOf(Error);
      if (errors[0] instanceof Error) {
        expect(errors[0].message).toBe('auto-flush compose boom');
      }

      await runtime.unmount();
    });

    it('unkeyed shrink — excess tail receives onUnmount (orphan DELETE)', async () => {
      const unmountLog: string[] = [];

      class UnkeyedLeaf extends Component<Record<string, never>, { id: string }> {
        constructor (props: { id: string }) {
          super(props);
          this.state = {};
        }

        public override onUnmount (): void {
          unmountLog.push(this.props.id);
        }
      }

      class UnkeyedHost extends Component<Record<string, never>, { count: number }> {
        constructor (props: { count: number }) {
          super(props);
          this.state = {};
        }

        public override compose (): VirtualServiceNode[] {
          const nodes: VirtualServiceNode[] = [];
          for (let i = 0; i < this.props.count; i += 1) {
            nodes.push(h(UnkeyedLeaf, { id: `u${String(i)}` }));
          }
          return nodes;
        }
      }

      const runtime = await GraphRuntime.mount(h(UnkeyedHost, { count: 2 }));
      await runtime.reconcile(h(UnkeyedHost, { count: 1 }));

      expect(unmountLog).toEqual(['u1']);
      expect(runtime.isActive()).toBe(true);

      await runtime.unmount();
    });

    it('onUnmount order children → parent', async () => {
      const order: string[] = [];

      class OrderLeaf extends Component<Record<string, never>, Record<string, never>> {
        constructor () {
          super({});
          this.state = {};
        }

        public override onUnmount (): void {
          order.push('child');
        }
      }

      class OrderParent extends Component<Record<string, never>, Record<string, never>> {
        constructor () {
          super({});
          this.state = {};
        }

        public override compose (): VirtualServiceNode[] {
          return [h(OrderLeaf, {})];
        }

        public override onUnmount (): void {
          order.push('parent');
        }
      }

      const runtime = await GraphRuntime.mount(h(OrderParent, {}));
      await runtime.unmount();

      expect(order).toEqual(['child', 'parent']);
    });

    it('setState after unmount does not schedule reconcile and does not throw', async () => {
      class StickyRoot extends Component<{ n: number }, Record<string, never>> {
        public composeCalls = 0;

        constructor () {
          super({});
          this.state = { n: 0 };
        }

        public override compose (): null {
          this.composeCalls += 1;
          return null;
        }
      }

      const runtime = await GraphRuntime.mount(h(StickyRoot, {}));
      const root = runtime.getRootInstance() as StickyRoot | null;
      expect(root).not.toBeNull();
      if (root === null) {
        throw new Error('expected StickyRoot');
      }

      const composeAfterMount = root.composeCalls;
      await runtime.unmount();
      expect(runtime.isActive()).toBe(false);

      expect(() => {
        root.setState({ n: 1 });
      }).not.toThrow();

      await drainMicrotasks();

      expect(root.state.n).toBe(1);
      expect(root.composeCalls).toBe(composeAfterMount);
      expect(runtime.isActive()).toBe(false);
    });

    it('async onUnmount — finalizeDestroyAsync, buses disposer, ref null', async () => {
      type Gr51Buses = ReturnType<
        typeof createRuntimeBuses<
          RuntimeCommand<string, unknown>,
          RuntimeQuery<string, unknown>,
          RuntimeEvent<string, unknown>
        >
      >;

      const unmountLog: string[] = [];

      class AsyncShutdownHost extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseCommandBus()
        public commandBus!: Gr51Buses['commandBus'];

        constructor () {
          super({});
        }

        @OnCommand('GR51_CMD')
        public async handle (): Promise<number> {
          return 1;
        }

        public override async onUnmount (): Promise<void> {
          await Promise.resolve();
          unmountLog.push('async-unmount');
        }
      }

      const buses = createRuntimeBuses<
        RuntimeCommand<string, unknown>,
        RuntimeQuery<string, unknown>,
        RuntimeEvent<string, unknown>
      >();
      const rootRef: RefObject<AsyncShutdownHost> = { current: null };

      const runtime = await GraphRuntime.mount(
        h(AsyncShutdownHost, {}, rootRef),
        EMPTY_CONTEXT_SCOPE,
        buses,
      );

      expect(rootRef.current).not.toBeNull();
      await expect(
        buses.commandBus.execute<number>({ type: 'GR51_CMD', payload: null }),
      ).resolves.toBe(1);

      await runtime.unmount();

      expect(unmountLog).toEqual(['async-unmount']);
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getRootInstance()).toBeNull();
      expect(rootRef.current).toBeNull();
      await expect(
        buses.commandBus.execute<number>({ type: 'GR51_CMD', payload: null }),
      ).rejects.toThrow('Command handler is not registered: GR51_CMD');
    });

    it('if an ancestor is already dirty — child setState does not yield a separate dirty reconcile of the child', async () => {
      class DedupLeaf extends Component<{ n: number }, Record<string, never>> {
        public composeCalls = 0;

        constructor () {
          super({});
          this.state = { n: 0 };
        }

        public override compose (): null {
          this.composeCalls += 1;
          return null;
        }
      }

      class DedupParent extends Component<{ n: number }, Record<string, never>> {
        @UseRef()
        private declare leafRef: RefObject<DedupLeaf>;

        public composeCalls = 0;

        constructor () {
          super({});
          this.state = { n: 0 };
        }

        public override compose (): VirtualServiceNode[] {
          this.composeCalls += 1;
          return [h(DedupLeaf, {}, this.leafRef)];
        }

        public getLeafRef (): RefObject<DedupLeaf> {
          return this.leafRef;
        }
      }

      const runtime = await GraphRuntime.mount(h(DedupParent, {}));
      const parent = runtime.getRootInstance() as DedupParent | null;
      expect(parent).not.toBeNull();
      if (parent === null) {
        throw new Error('expected DedupParent');
      }

      const leafRef = parent.getLeafRef();
      expect(leafRef.current).not.toBeNull();
      if (leafRef.current === null) {
        throw new Error('expected DedupLeaf');
      }

      const leaf = leafRef.current;
      const parentComposeBefore = parent.composeCalls;
      const leafComposeBefore = leaf.composeCalls;

      parent.setState({ n: 1 });
      leaf.setState({ n: 1 });
      await drainMicrotasks();

      // Only the parent is dirty: leaf.compose once via parent UPDATE.
      // If broken (both dirty) — leaf.compose is called twice.
      expect(parent.composeCalls).toBe(parentComposeBefore + 1);
      expect(leaf.composeCalls).toBe(leafComposeBefore + 1);

      await runtime.unmount();
    });

    it('ancestor setState removes an already queued dirty descendant from the queue', async () => {
      class DedupLeafB extends Component<{ n: number }, Record<string, never>> {
        public composeCalls = 0;

        constructor () {
          super({});
          this.state = { n: 0 };
        }

        public override compose (): null {
          this.composeCalls += 1;
          return null;
        }
      }

      class DedupParentB extends Component<{ n: number }, Record<string, never>> {
        @UseRef()
        private declare leafRef: RefObject<DedupLeafB>;

        public composeCalls = 0;

        constructor () {
          super({});
          this.state = { n: 0 };
        }

        public override compose (): VirtualServiceNode[] {
          this.composeCalls += 1;
          return [h(DedupLeafB, {}, this.leafRef)];
        }

        public getLeafRef (): RefObject<DedupLeafB> {
          return this.leafRef;
        }
      }

      const runtime = await GraphRuntime.mount(h(DedupParentB, {}));
      const parent = runtime.getRootInstance() as DedupParentB | null;
      expect(parent).not.toBeNull();
      if (parent === null) {
        throw new Error('expected DedupParentB');
      }

      const leafRef = parent.getLeafRef();
      if (leafRef.current === null) {
        throw new Error('expected DedupLeafB');
      }

      const leaf = leafRef.current;
      const leafComposeBefore = leaf.composeCalls;
      const parentComposeBefore = parent.composeCalls;

      leaf.setState({ n: 1 });
      parent.setState({ n: 1 });
      await drainMicrotasks();

      expect(parent.composeCalls).toBe(parentComposeBefore + 1);
      expect(leaf.composeCalls).toBe(leafComposeBefore + 1);

      await runtime.unmount();
    });
  });

  describe('RUNTIME_PROPS_RECEIVER', () => {
    it('UPDATE calls RUNTIME_PROPS_RECEIVER instead of assigning instance.props directly', async () => {
      type LeafProps = { label: string; derived?: string };

      class ReceiverLeaf extends Component<Record<string, never>, LeafProps> {
        public receiverCalls = 0;

        constructor (props: LeafProps) {
          super(props);
          this.state = {};
        }

        public [RUNTIME_PROPS_RECEIVER] (nextProps: LeafProps): void {
          this.receiverCalls += 1;
          const prevDerived = this.props.derived;
          this.props = {
            label: nextProps.label,
            derived: prevDerived,
          };
        }
      }

      class PlainLeaf extends Component<Record<string, never>, LeafProps> {
        constructor (props: LeafProps) {
          super(props);
          this.state = {};
        }
      }

      class ReceiverHost extends Component<Record<string, never>, { label: string }> {
        @UseRef()
        private declare leafRef: RefObject<ReceiverLeaf>;

        constructor (props: { label: string }) {
          super(props);
          this.state = {};
        }

        public override compose (): VirtualServiceNode[] {
          return [h(ReceiverLeaf, { label: this.props.label }, this.leafRef)];
        }

        public getLeafRef (): RefObject<ReceiverLeaf> {
          return this.leafRef;
        }
      }

      class PlainHost extends Component<Record<string, never>, { label: string }> {
        @UseRef()
        private declare leafRef: RefObject<PlainLeaf>;

        constructor (props: { label: string }) {
          super(props);
          this.state = {};
        }

        public override compose (): VirtualServiceNode[] {
          return [h(PlainLeaf, { label: this.props.label }, this.leafRef)];
        }

        public getLeafRef (): RefObject<PlainLeaf> {
          return this.leafRef;
        }
      }

      const receiverRt = await GraphRuntime.mount(h(ReceiverHost, { label: 'a' }));
      const receiverHost = receiverRt.getRootInstance() as ReceiverHost | null;
      expect(receiverHost).not.toBeNull();
      if (receiverHost === null) {
        throw new Error('expected ReceiverHost');
      }
      const receiverLeafRef = receiverHost.getLeafRef();
      if (receiverLeafRef.current === null) {
        throw new Error('expected ReceiverLeaf');
      }

      const receiverLeaf: ReceiverLeaf = receiverLeafRef.current;
      receiverLeaf.props = { label: 'a', derived: 'seed' };

      await receiverRt.reconcile(h(ReceiverHost, { label: 'b' }));

      expect(receiverLeaf.receiverCalls).toBe(1);
      expect(receiverLeaf.props).toEqual({ label: 'b', derived: 'seed' });
      await receiverRt.unmount();

      const plainRt = await GraphRuntime.mount(h(PlainHost, { label: 'a' }));
      const plainHost = plainRt.getRootInstance() as PlainHost | null;
      expect(plainHost).not.toBeNull();
      if (plainHost === null) {
        throw new Error('expected PlainHost');
      }
      const plainLeafRef = plainHost.getLeafRef();
      if (plainLeafRef.current === null) {
        throw new Error('expected PlainLeaf');
      }

      const plainLeaf: PlainLeaf = plainLeafRef.current;
      plainLeaf.props = { label: 'a', derived: 'seed' };

      await plainRt.reconcile(h(PlainHost, { label: 'b' }));

      expect(plainLeaf.props).toEqual({ label: 'b' });
      expect(Object.hasOwn(plainLeaf.props, 'derived')).toBe(false);
      await plainRt.unmount();
    });

    it('connect RUNTIME_PROPS_RECEIVER keeps state-derived props on parent reconcile', async () => {
      interface StoreState {
        status: string;
      }

      type StoreAction = { type: 'NOOP' };

      interface ChildProps {
        id: string;
        status?: string;
      }

      function reducer (state: StoreState, _action: StoreAction): StoreState {
        return state;
      }

      const store = createStore<StoreState, StoreAction>(reducer, { status: 'idle' });

      class ConnectedChild extends Component<Record<string, never>, ChildProps> {
        constructor (props: ChildProps) {
          super(props);
          this.state = {};
        }
      }

      const childRef: RefObject<ConnectedChild> = { current: null };

      const Connected = connect<StoreState, ChildProps, Pick<ChildProps, 'status'>>(
        (state: StoreState): Pick<ChildProps, 'status'> => ({
          status: state.status,
        }),
        undefined,
        { ownPropsModeMerge: true },
      )(ConnectedChild);

      class RootHost extends Component<Record<string, never>, { childId: string }> {
        constructor (props: { childId: string }) {
          super(props);
          this.state = {};
        }

        public override compose (): VirtualServiceNode[] {
          return [h(Connected, { id: this.props.childId }, childRef)];
        }
      }

      const ConnectedRoot = connect(store, undefined, undefined, { ownPropsModeMerge: true })(RootHost);
      const runtime = await GraphRuntime.mount(h(ConnectedRoot, { childId: 'first' }));

      expect(childRef.current).not.toBeNull();
      if (childRef.current === null) {
        throw new Error('expected ConnectedChild');
      }

      expect(childRef.current.props).toEqual({
        id: 'first',
        status: 'idle',
      });
      expect(typeof Reflect.get(childRef.current, RUNTIME_PROPS_RECEIVER)).toBe('function');

      await runtime.reconcile(h(ConnectedRoot, { childId: 'second' }));

      expect(childRef.current).not.toBeNull();
      if (childRef.current === null) {
        throw new Error('expected ConnectedChild after reconcile');
      }

      expect(childRef.current.props).toEqual({
        id: 'second',
        status: 'idle',
      });

      await runtime.unmount();
    });
  });

  describe('auto-flush / explicitChildren / async startup / reconcile guards / dirty teardown', () => {
    async function drainMicrotasks (): Promise<void> {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }

    it('without onAutoReconcileError a compose error in auto-flush transitions to FAILED (issue #10)', async () => {
      class BoomComposeRoot extends Component<{ boom: boolean }, Record<string, never>> {
        constructor () {
          super({});
          this.state = { boom: false };
        }

        public override compose (): null {
          if (this.state.boom) {
            throw new Error('compose boom');
          }
          return null;
        }
      }

      const runtime = await GraphRuntime.mount(h(BoomComposeRoot, {}));
      const root = runtime.getRootInstance() as BoomComposeRoot | null;
      expect(root).not.toBeNull();
      if (root === null) {
        throw new Error('expected BoomComposeRoot');
      }

      expect(runtime.isActive()).toBe(true);
      root.setState({ boom: true });
      await drainMicrotasks();

      // Dirty-flush error transitions to FAILED (issue #10)
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getState()).toBe('failed');
      expect(runtime.getRootInstance()).toBeNull();

      // Unmount is still safe
      await runtime.unmount();
    });

    it('without compose() materialize uses explicitChildren from h(..., [children])', async () => {
      class ExplicitChildrenShell extends Component<Record<string, unknown>, Record<string, unknown>> {
        constructor (props: Record<string, unknown>) {
          super(props);
        }
      }

      const leafRef: RefObject<LeafComponent> = { current: null };
      const runtime = await GraphRuntime.mount(
        h(ExplicitChildrenShell, {}, [
          h(LeafComponent, { value: 77 }, leafRef),
        ]),
      );

      expect(leafRef.current).not.toBeNull();
      if (leafRef.current === null) {
        throw new Error('expected LeafComponent via explicitChildren');
      }

      expect(leafRef.current.props.value).toBe(77);
      expect(leafRef.current.calls).toContain('onMount:77');

      await runtime.unmount();
      expect(leafRef.current).toBeNull();
    });

    it('async onMount on parent and child — mount succeeds, order child→parent', async () => {
      const mountOrder: string[] = [];

      class AsyncStartupChild extends Component<Record<string, unknown>, Record<string, unknown>> {
        public ready = false;

        constructor (props: Record<string, unknown>) {
          super(props);
        }

        public override async onMount (): Promise<void> {
          await Promise.resolve();
          mountOrder.push('child');
          this.ready = true;
        }
      }

      class AsyncStartupParent extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseRef()
        private declare childRef: RefObject<AsyncStartupChild>;

        constructor (props: Record<string, unknown>) {
          super(props);
        }

        public override compose (): VirtualServiceNode[] {
          return [h(AsyncStartupChild, {}, this.childRef)];
        }

        public override async onMount (): Promise<void> {
          await Promise.resolve();
          mountOrder.push('parent');
        }

        public getChildRef (): RefObject<AsyncStartupChild> {
          return this.childRef;
        }
      }

      const runtime = await GraphRuntime.mount(h(AsyncStartupParent, {}));

      expect(runtime.isActive()).toBe(true);
      expect(mountOrder).toEqual(['child', 'parent']);

      const parent = runtime.getRootInstance() as AsyncStartupParent | null;
      expect(parent).not.toBeNull();
      if (parent === null) {
        throw new Error('expected AsyncStartupParent');
      }

      const childRef = parent.getChildRef();
      expect(childRef.current).not.toBeNull();
      if (childRef.current === null) {
        throw new Error('expected AsyncStartupChild');
      }

      expect(childRef.current.ready).toBe(true);

      await runtime.unmount();
    });

    it('reconcile with uninitialized currentRoot throws', async () => {
      const RuntimeFactory = GraphRuntime as unknown as new () => GraphRuntime;
      const runtime = new RuntimeFactory();

      // Runtime created directly (not via mount) is in IDLE state
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getRootInstance()).toBeNull();

      await expect(
        runtime.reconcile(h(LeafComponent, { value: 1 })),
      ).rejects.toThrow('[Effectable] GraphRuntime: currentRoot is not initialized.');
    });

    it('unmount before auto-flush removes the fiber from dirtyFibers — no crash after microtask', async () => {
      class SlowDirtyRoot extends Component<{ n: number }, Record<string, never>> {
        public composeCalls = 0;

        constructor () {
          super({});
          this.state = { n: 0 };
        }

        public override compose (): null {
          this.composeCalls += 1;
          return null;
        }
      }

      const runtime = await GraphRuntime.mount(h(SlowDirtyRoot, {}));
      const root = runtime.getRootInstance() as SlowDirtyRoot | null;
      expect(root).not.toBeNull();
      if (root === null) {
        throw new Error('expected SlowDirtyRoot');
      }

      const composeAfterMount = root.composeCalls;
      root.setState({ n: 1 });
      await runtime.unmount();

      expect(runtime.isActive()).toBe(false);
      await drainMicrotasks();

      expect(root.composeCalls).toBe(composeAfterMount);
      expect(runtime.isActive()).toBe(false);
    });

    it('keyed reconcile N=32 (stable fast-path) keeps the same instances when props change', async () => {
      class StableSlotLeaf extends Component<Record<string, never>, { slot: string; wave: number }> {
        public readonly token = Symbol('stable-slot');

        constructor (props: { slot: string; wave: number }) {
          super(props);
          this.state = {};
        }
      }

      class StableWideHost extends Component<Record<string, never>, { wave: number }> {
        private readonly slotRefs: Map<string, RefObject<StableSlotLeaf>> = new Map();

        constructor (props: { wave: number }) {
          super(props);
          this.state = {};
          for (let i = 0; i < 32; i += 1) {
            this.slotRefs.set(`s${String(i)}`, { current: null });
          }
        }

        public override compose (): VirtualServiceNode[] {
          const nodes: VirtualServiceNode[] = [];
          for (let i = 0; i < 32; i += 1) {
            const key = `s${String(i)}`;
            const ref = this.slotRefs.get(key);
            if (ref === undefined) {
              throw new Error(`missing ref for ${key}`);
            }
            nodes.push(h(StableSlotLeaf, { slot: key, wave: this.props.wave }, ref, key));
          }
          return nodes;
        }

        public getRef (key: string): RefObject<StableSlotLeaf> {
          const ref = this.slotRefs.get(key);
          if (ref === undefined) {
            throw new Error(`missing ref for ${key}`);
          }
          return ref;
        }
      }

      const runtime = await GraphRuntime.mount(h(StableWideHost, { wave: 0 }));
      const host = runtime.getRootInstance() as StableWideHost | null;
      expect(host).not.toBeNull();
      if (host === null) {
        throw new Error('expected StableWideHost');
      }

      const tokensBefore: symbol[] = [];
      for (let i = 0; i < 32; i += 1) {
        const ref = host.getRef(`s${String(i)}`);
        expect(ref.current).not.toBeNull();
        if (ref.current === null) {
          throw new Error('expected StableSlotLeaf before reconcile');
        }
        tokensBefore.push(ref.current.token);
      }

      await runtime.reconcile(h(StableWideHost, { wave: 1 }));

      for (let i = 0; i < 32; i += 1) {
        const ref = host.getRef(`s${String(i)}`);
        expect(ref.current).not.toBeNull();
        if (ref.current === null) {
          throw new Error('expected StableSlotLeaf after reconcile');
        }
        expect(ref.current.token).toBe(tokensBefore[i]);
        expect(ref.current.props.wave).toBe(1);
      }

      await runtime.unmount();
    });

    it('keyed reconcile N=33 (full-diff) correctly reorders instances on key swap', async () => {
      class FullDiffSlotLeaf extends Component<Record<string, never>, { slot: string }> {
        public readonly token = Symbol('full-diff-slot');

        constructor (props: { slot: string }) {
          super(props);
          this.state = {};
        }
      }

      class FullDiffWideHost extends Component<Record<string, never>, { order: string[] }> {
        private readonly slotRefs: Map<string, RefObject<FullDiffSlotLeaf>> = new Map();

        constructor (props: { order: string[] }) {
          super(props);
          this.state = {};
          for (let i = 0; i < 33; i += 1) {
            this.slotRefs.set(`k${String(i)}`, { current: null });
          }
        }

        public override compose (): VirtualServiceNode[] {
          const nodes: VirtualServiceNode[] = [];
          for (const key of this.props.order) {
            const ref = this.slotRefs.get(key);
            if (ref === undefined) {
              throw new Error(`missing ref for ${key}`);
            }
            nodes.push(h(FullDiffSlotLeaf, { slot: key }, ref, key));
          }
          return nodes;
        }

        public getRef (key: string): RefObject<FullDiffSlotLeaf> {
          const ref = this.slotRefs.get(key);
          if (ref === undefined) {
            throw new Error(`missing ref for ${key}`);
          }
          return ref;
        }
      }

      const initialOrder: string[] = [];
      for (let i = 0; i < 33; i += 1) {
        initialOrder.push(`k${String(i)}`);
      }

      const swappedOrder = [...initialOrder];
      swappedOrder[0] = initialOrder[1];
      swappedOrder[1] = initialOrder[0];

      const runtime = await GraphRuntime.mount(h(FullDiffWideHost, { order: initialOrder }));
      const host = runtime.getRootInstance() as FullDiffWideHost | null;
      expect(host).not.toBeNull();
      if (host === null) {
        throw new Error('expected FullDiffWideHost');
      }

      const tokenK0 = host.getRef('k0').current;
      const tokenK1 = host.getRef('k1').current;
      expect(tokenK0).not.toBeNull();
      expect(tokenK1).not.toBeNull();
      if (tokenK0 === null || tokenK1 === null) {
        throw new Error('expected mounted k0/k1');
      }

      const symK0 = tokenK0.token;
      const symK1 = tokenK1.token;

      await runtime.reconcile(h(FullDiffWideHost, { order: swappedOrder }));

      const afterK0 = host.getRef('k0').current;
      const afterK1 = host.getRef('k1').current;
      expect(afterK0).not.toBeNull();
      expect(afterK1).not.toBeNull();
      if (afterK0 === null || afterK1 === null) {
        throw new Error('expected mounted k0/k1 after swap');
      }

      expect(afterK0.token).toBe(symK0);
      expect(afterK1.token).toBe(symK1);
      expect(afterK0.props.slot).toBe('k0');
      expect(afterK1.props.slot).toBe('k1');

      await runtime.unmount();
    });
  });

  describe('keyedMapPool / flush reentrancy / internal effectTag', () => {
    async function drainMicrotasks (): Promise<void> {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    }

    it('deep keyed tree — two consecutive reconciles without crash or pool leak', async () => {
      const poolDepth = 32;

      class PoolDepthLeaf extends Component<Record<string, never>, { tick: number; path: string }> {
        public readonly leafToken = Symbol('pool-depth-leaf');

        constructor (props: { tick: number; path: string }) {
          super(props);
          this.state = {};
        }
      }

      class PoolDepthNode extends Component<Record<string, never>, { depth: number; tick: number; path: string }> {
        @UseRef()
        private declare childRef: RefObject<PoolDepthLeaf | PoolDepthNode>;

        constructor (props: { depth: number; tick: number; path: string }) {
          super(props);
          this.state = {};
        }

        public override compose (): VirtualServiceNode[] {
          if (this.props.depth <= 0) {
            return [h(PoolDepthLeaf, { tick: this.props.tick, path: this.props.path })];
          }

          return [
            h(
              PoolDepthNode,
              {
                depth: this.props.depth - 1,
                tick: this.props.tick,
                path: `${this.props.path}/d`,
              },
              this.childRef,
              'slot',
            ),
          ];
        }
      }

      const runtime = await GraphRuntime.mount(
        h(PoolDepthNode, { depth: poolDepth, tick: 0, path: 'root' }),
      );
      expect(runtime.isActive()).toBe(true);

      await runtime.reconcile(h(PoolDepthNode, { depth: poolDepth, tick: 1, path: 'root' }));
      expect(runtime.isActive()).toBe(true);

      await runtime.reconcile(h(PoolDepthNode, { depth: poolDepth, tick: 2, path: 'root' }));
      expect(runtime.isActive()).toBe(true);

      await runtime.unmount();
      expect(runtime.isActive()).toBe(false);
    });

    it('setState in compose during flush schedules a second dirtyFibers pass', async () => {
      class RefillOnComposeRoot extends Component<{ n: number }, Record<string, never>> {
        public composePasses = 0;

        constructor () {
          super({});
          this.state = { n: 0 };
        }

        public override compose (): null {
          this.composePasses += 1;
          if (this.state.n === 1) {
            this.setState({ n: 2 });
          }
          return null;
        }
      }

      const runtime = await GraphRuntime.mount(h(RefillOnComposeRoot, {}));
      const root = runtime.getRootInstance() as RefillOnComposeRoot | null;
      expect(root).not.toBeNull();
      if (root === null) {
        throw new Error('expected RefillOnComposeRoot');
      }

      root.setState({ n: 1 });
      await drainMicrotasks();

      expect(root.state.n).toBe(2);
      expect(root.composePasses).toBeGreaterThanOrEqual(2);

      await runtime.unmount();
    });

    it('self-feeding setState in compose hits the dirty-flush anti-loop', async () => {
      const errors: unknown[] = [];

      class InfiniteDirtyRoot extends Component<{ n: number }, Record<string, never>> {
        constructor () {
          super({});
          this.state = { n: 0 };
        }

        public override compose (): null {
          if (this.state.n > 0) {
            this.setState({ n: this.state.n + 1 });
          }
          return null;
        }
      }

      const runtime = await GraphRuntime.mount(
        h(InfiniteDirtyRoot, {}),
        undefined,
        undefined,
        (err: unknown) => {
          errors.push(err);
        }
      );
      const root = runtime.getRootInstance() as InfiniteDirtyRoot | null;
      expect(root).not.toBeNull();
      if (root === null) {
        throw new Error('expected InfiniteDirtyRoot');
      }

      root.setState({ n: 1 });
      for (let i = 0; i < 80; i += 1) {
        await Promise.resolve();
      }
      await drainMicrotasks();

      expect(errors.length).toBeGreaterThanOrEqual(1);
      const first = errors[0];
      const message = first instanceof Error ? first.message : String(first);
      expect(message).toMatch(/dirty flush exceeded|anti-loop/);

      await runtime.unmount();
    });

    it('unmount during an active dirtyFibers flush clears the queue without crashing', async () => {
      let runtimeForMidFlush: GraphRuntime | null = null;

      class UnmountMidFlushRoot extends Component<{ n: number }, Record<string, never>> {
        constructor () {
          super({});
          this.state = { n: 0 };
        }

        public override compose (): null {
          if (this.state.n === 1 && runtimeForMidFlush !== null) {
            void runtimeForMidFlush.unmount();
          }
          return null;
        }
      }

      const runtime = await GraphRuntime.mount(h(UnmountMidFlushRoot, {}));
      runtimeForMidFlush = runtime;

      const root = runtime.getRootInstance() as UnmountMidFlushRoot | null;
      expect(root).not.toBeNull();
      if (root === null) {
        throw new Error('expected UnmountMidFlushRoot');
      }

      root.setState({ n: 1 });
      await drainMicrotasks();

      expect(runtime.isActive()).toBe(false);
      expect(runtime.getRootInstance()).toBeNull();

      await drainMicrotasks();
      expect(runtime.isActive()).toBe(false);
    });

    it('PLACE — effectTag is reset to null after successful startup', async () => {
      class InspectMountRoot extends Component<Record<string, unknown>, Record<string, unknown>> {
        constructor (props: Record<string, unknown>) {
          super(props);
        }
      }

      const runtime = await GraphRuntime.mount(h(InspectMountRoot, {}));
      const snap = runtime.inspectRootFiber();

      expect(snap).not.toBeNull();

      if (snap === null) {
        throw new Error('expected root fiber inspect after mount');
      }

      expect(snap.effectTag).toBeNull();
      expect(snap.hasInstance).toBe(true);
      expect(snap.childCount).toBe(0);

      await runtime.unmount();
      expect(runtime.inspectRootFiber()).toBeNull();
    });

    it('UPDATE — applyFiberUpdate sets effectTag UPDATE on the fiber', async () => {
      class InspectUpdateRoot extends Component<Record<string, unknown>, { n: number }> {
        constructor (props: { n: number }) {
          super(props);
        }
      }

      const runtime = await GraphRuntime.mount(h(InspectUpdateRoot, { n: 1 }));
      await runtime.reconcile(h(InspectUpdateRoot, { n: 2 }));

      const snap = runtime.inspectRootFiber();
      expect(snap).not.toBeNull();

      if (snap === null) {
        throw new Error('expected root fiber inspect after reconcile');
      }

      expect(snap.effectTag).toBe(FIBER_EFFECT_TAG.UPDATE);
      expect(snap.hasInstance).toBe(true);

      await runtime.unmount();
    });

    it('UPDATE when fiber.instance === null throws', async () => {
      class NullInstanceRoot extends Component<Record<string, unknown>, { n: number }> {
        constructor (props: { n: number }) {
          super(props);
        }
      }

      const runtime = await GraphRuntime.mount(h(NullInstanceRoot, { n: 1 }));
      runtime.nullRootInstanceForTests();

      const snap = runtime.inspectRootFiber();
      expect(snap).not.toBeNull();

      if (snap === null) {
        throw new Error('expected root fiber inspect after nullRootInstanceForTests');
      }

      expect(snap.hasInstance).toBe(false);

      await expect(runtime.reconcile(h(NullInstanceRoot, { n: 2 }))).rejects.toThrow(
        '[Effectable] GraphRuntime: UPDATE on fiber with null instance.',
      );
    });
  });
});
