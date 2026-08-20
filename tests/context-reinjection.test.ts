/**
 * Tests for issue #15: context re-injection on reused components.
 *
 * @module Effectable/tests/context-reinjection.test
 */

import {
  Component,
  ContextProvider,
  GraphRuntime,
  UseContext,
  UseRef,
  createContext,
  h,
} from 'Effectable';
import { IS_CONTEXT_PROVIDER } from 'Effectable/component/context';
import type { ContextScope, RefObject, VirtualServiceNode } from 'Effectable';

const TEST_CONTEXT = createContext<number>('TEST_CONTEXT');
const TEST_CONTEXT_A = createContext<string>('TEST_CONTEXT_A');
const TEST_CONTEXT_B = createContext<number>('TEST_CONTEXT_B');

describe('Issue #15: context re-injection on update', () => {
  it('scope identity change triggers re-injection', async () => {
    class Consumer extends Component<Record<string, never>, Record<string, never>> {
      @UseContext(TEST_CONTEXT)
      public value = -1;

      public onUpdateCallCount = 0;
      public lastSeenValue: number | undefined;

      constructor () {
        super({});
      }

      public override onUpdate (): void {
        this.onUpdateCallCount += 1;
        this.lastSeenValue = this.value;
      }
    }

    class Root extends Component<Record<string, never>, { providerValue: number }> {
      @UseRef()
      private declare consumerRef: RefObject<Consumer>;

      constructor (props: { providerValue: number }) {
        super(props);
      }

      public getConsumerRef (): RefObject<Consumer> {
        return this.consumerRef;
      }

      public override compose (): VirtualServiceNode[] {
        return [
          h(ContextProvider, { value: [TEST_CONTEXT, this.props.providerValue] }, [
            h(Consumer, {}, this.consumerRef),
          ]),
        ];
      }
    }

    const runtime = await GraphRuntime.mount(h(Root, { providerValue: 10 }));

    const root = runtime.getRootInstance() as Root | null;
    expect(root).not.toBeNull();

    const consumerRef = root!.getConsumerRef();
    expect(consumerRef.current).not.toBeNull();

    expect(consumerRef.current!.value).toBe(10);
    expect(consumerRef.current!.onUpdateCallCount).toBe(0);

    await runtime.reconcile(h(Root, { providerValue: 20 }));

    expect(consumerRef.current!.value).toBe(20);
    expect(consumerRef.current!.lastSeenValue).toBe(20);
    expect(consumerRef.current!.onUpdateCallCount).toBe(1);

    await runtime.unmount();
  });

  it('nested providers shadow correctly after value change', async () => {
    class Consumer extends Component<Record<string, never>, Record<string, never>> {
      @UseContext(TEST_CONTEXT)
      public value = -1;

      public onUpdateCallCount = 0;

      constructor () {
        super({});
      }

      public override onUpdate (): void {
        this.onUpdateCallCount += 1;
      }
    }

    class Root extends Component<Record<string, never>, { innerValue: number }> {
      @UseRef()
      private declare consumerRef: RefObject<Consumer>;

      constructor (props: { innerValue: number }) {
        super(props);
      }

      public getConsumerRef (): RefObject<Consumer> {
        return this.consumerRef;
      }

      public override compose (): VirtualServiceNode[] {
        return [
          h(ContextProvider, { value: [TEST_CONTEXT, 100] }, [
            h(ContextProvider, { value: [TEST_CONTEXT, this.props.innerValue] }, [
              h(Consumer, {}, this.consumerRef),
            ]),
          ]),
        ];
      }
    }

    const runtime = await GraphRuntime.mount(h(Root, { innerValue: 1 }));

    const root = runtime.getRootInstance() as Root | null;
    expect(root).not.toBeNull();

    const consumerRef = root!.getConsumerRef();
    expect(consumerRef.current).not.toBeNull();

    expect(consumerRef.current!.value).toBe(1);

    await runtime.reconcile(h(Root, { innerValue: 2 }));

    expect(consumerRef.current!.value).toBe(2);
    expect(consumerRef.current!.onUpdateCallCount).toBe(1);

    await runtime.unmount();
  });

  it('removing an inner provider restores the outer value on reused consumer', async () => {
    // This test uses a custom provider that conditionally extends scope or passes it through.
    // When active=false, it acts as a passthrough, effectively "removing" its provision
    // while keeping the tree structure stable so the consumer is reused (UPDATE, not DELETE+PLACE).
    
    class Consumer extends Component<Record<string, never>, Record<string, never>> {
      @UseContext(TEST_CONTEXT)
      public value = -1;

      public onUpdateCallCount = 0;
      public mountCount = 0;

      constructor () {
        super({});
      }

      public override onMount (): void {
        this.mountCount += 1;
      }

      public override onUpdate (): void {
        this.onUpdateCallCount += 1;
      }
    }

    interface ConditionalProviderShellProps {
      active: boolean;
      value: number;
      children: VirtualServiceNode[];
    }

    class ConditionalProviderShell extends Component<Record<string, never>, ConditionalProviderShellProps> {
      constructor (props: ConditionalProviderShellProps) {
        super(props);
      }

      public applyToScope (parentScope: ContextScope): ContextScope {
        if (this.props.active) {
          const delegate = new ContextProvider({ value: [TEST_CONTEXT, this.props.value] });
          return delegate.applyToScope(parentScope);
        }
        return parentScope;
      }

      public override compose (): VirtualServiceNode[] {
        return this.props.children;
      }
    }

    Object.defineProperty(ConditionalProviderShell.prototype, IS_CONTEXT_PROVIDER, {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    class Root extends Component<Record<string, never>, { innerActive: boolean }> {
      @UseRef()
      private declare consumerRef: RefObject<Consumer>;

      constructor (props: { innerActive: boolean }) {
        super(props);
      }

      public getConsumerRef (): RefObject<Consumer> {
        return this.consumerRef;
      }

      public override compose (): VirtualServiceNode[] {
        return [
          h(ContextProvider, { value: [TEST_CONTEXT, 100] }, [
            h(ConditionalProviderShell, {
              active: this.props.innerActive,
              value: 200,
              children: [h(Consumer, {}, this.consumerRef)],
            }),
          ]),
        ];
      }
    }

    const runtime = await GraphRuntime.mount(h(Root, { innerActive: true }));

    const root = runtime.getRootInstance() as Root | null;
    expect(root).not.toBeNull();

    const consumerRef = root!.getConsumerRef();
    expect(consumerRef.current).not.toBeNull();

    expect(consumerRef.current!.value).toBe(200);
    expect(consumerRef.current!.mountCount).toBe(1);

    await runtime.reconcile(h(Root, { innerActive: false }));

    expect(consumerRef.current).not.toBeNull();
    expect(consumerRef.current!.value).toBe(100);
    expect(consumerRef.current!.mountCount).toBe(1);
    expect(consumerRef.current!.onUpdateCallCount).toBe(1);

    await runtime.unmount();
  });

  it('changing provider value when tree structure stays constant', async () => {
    class Consumer extends Component<Record<string, never>, Record<string, never>> {
      @UseContext(TEST_CONTEXT)
      public value = -1;

      public onUpdateCallCount = 0;
      public mountCount = 0;

      constructor () {
        super({});
      }

      public override onMount (): void {
        this.mountCount += 1;
      }

      public override onUpdate (): void {
        this.onUpdateCallCount += 1;
      }
    }

    class Inner extends Component<Record<string, never>, { providerValue: number }> {
      @UseRef()
      private declare consumerRef: RefObject<Consumer>;

      constructor (props: { providerValue: number }) {
        super(props);
      }

      public getConsumerRef (): RefObject<Consumer> {
        return this.consumerRef;
      }

      public override compose (): VirtualServiceNode[] {
        return [
          h(ContextProvider, { value: [TEST_CONTEXT, this.props.providerValue] }, [
            h(Consumer, {}, this.consumerRef),
          ]),
        ];
      }
    }

    class Root extends Component<Record<string, never>, { innerValue: number }> {
      @UseRef()
      private declare innerRef: RefObject<Inner>;

      constructor (props: { innerValue: number }) {
        super(props);
      }

      public getInnerRef (): RefObject<Inner> {
        return this.innerRef;
      }

      public override compose (): VirtualServiceNode[] {
        return [
          h(ContextProvider, { value: [TEST_CONTEXT, 100] }, [
            h(Inner, { providerValue: this.props.innerValue }, this.innerRef),
          ]),
        ];
      }
    }

    const runtime = await GraphRuntime.mount(h(Root, { innerValue: 200 }));

    const root = runtime.getRootInstance() as Root | null;
    expect(root).not.toBeNull();

    const innerRef = root!.getInnerRef();
    expect(innerRef.current).not.toBeNull();

    const consumerRef = innerRef.current!.getConsumerRef();
    expect(consumerRef.current).not.toBeNull();

    expect(consumerRef.current!.value).toBe(200);
    expect(consumerRef.current!.mountCount).toBe(1);

    await runtime.reconcile(h(Root, { innerValue: 300 }));

    expect(consumerRef.current!.value).toBe(300);
    expect(consumerRef.current!.mountCount).toBe(1);
    expect(consumerRef.current!.onUpdateCallCount).toBeGreaterThan(0);

    await runtime.unmount();
  });

  it('multiple context pairs update correctly', async () => {
    class Consumer extends Component<Record<string, never>, Record<string, never>> {
      @UseContext(TEST_CONTEXT_A)
      public valueA = '';

      @UseContext(TEST_CONTEXT_B)
      public valueB = -1;

      public onUpdateCallCount = 0;

      constructor () {
        super({});
      }

      public override onUpdate (): void {
        this.onUpdateCallCount += 1;
      }
    }

    class Root extends Component<Record<string, never>, { a: string; b: number }> {
      @UseRef()
      private declare consumerRef: RefObject<Consumer>;

      constructor (props: { a: string; b: number }) {
        super(props);
      }

      public getConsumerRef (): RefObject<Consumer> {
        return this.consumerRef;
      }

      public override compose (): VirtualServiceNode[] {
        return [
          h(ContextProvider, {
            value: [
              [TEST_CONTEXT_A, this.props.a],
              [TEST_CONTEXT_B, this.props.b],
            ],
          }, [
            h(Consumer, {}, this.consumerRef),
          ]),
        ];
      }
    }

    const runtime = await GraphRuntime.mount(h(Root, { a: 'first', b: 10 }));

    const root = runtime.getRootInstance() as Root | null;
    expect(root).not.toBeNull();

    const consumerRef = root!.getConsumerRef();
    expect(consumerRef.current).not.toBeNull();

    expect(consumerRef.current!.valueA).toBe('first');
    expect(consumerRef.current!.valueB).toBe(10);

    await runtime.reconcile(h(Root, { a: 'second', b: 20 }));

    expect(consumerRef.current!.valueA).toBe('second');
    expect(consumerRef.current!.valueB).toBe(20);
    expect(consumerRef.current!.onUpdateCallCount).toBe(1);

    await runtime.unmount();
  });

  it('empty pair array throws validation error', async () => {
    class Root extends Component<Record<string, never>, Record<string, never>> {
      constructor () {
        super({});
      }

      public override compose (): VirtualServiceNode[] {
        return [
          h(ContextProvider, { value: [] as unknown as Array<[typeof TEST_CONTEXT, number]> }, []),
        ];
      }
    }

    await expect(GraphRuntime.mount(h(Root, {}))).rejects.toThrow(
      /empty value array is invalid/,
    );
  });

  it('context update combined with prop update', async () => {
    class Consumer extends Component<Record<string, never>, { label: string }> {
      @UseContext(TEST_CONTEXT)
      public contextValue = -1;

      public onUpdateCallCount = 0;
      public lastSeenProps: { label: string } | undefined;
      public lastSeenContext: number | undefined;

      constructor (props: { label: string }) {
        super(props);
      }

      public override onUpdate (): void {
        this.onUpdateCallCount += 1;
        this.lastSeenProps = this.props;
        this.lastSeenContext = this.contextValue;
      }
    }

    class Root extends Component<Record<string, never>, { contextVal: number; propVal: string }> {
      @UseRef()
      private declare consumerRef: RefObject<Consumer>;

      constructor (props: { contextVal: number; propVal: string }) {
        super(props);
      }

      public getConsumerRef (): RefObject<Consumer> {
        return this.consumerRef;
      }

      public override compose (): VirtualServiceNode[] {
        return [
          h(ContextProvider, { value: [TEST_CONTEXT, this.props.contextVal] }, [
            h(Consumer, { label: this.props.propVal }, this.consumerRef),
          ]),
        ];
      }
    }

    const runtime = await GraphRuntime.mount(h(Root, { contextVal: 10, propVal: 'a' }));

    const root = runtime.getRootInstance() as Root | null;
    expect(root).not.toBeNull();

    const consumerRef = root!.getConsumerRef();
    expect(consumerRef.current).not.toBeNull();

    expect(consumerRef.current!.contextValue).toBe(10);
    expect(consumerRef.current!.props.label).toBe('a');

    await runtime.reconcile(h(Root, { contextVal: 20, propVal: 'b' }));

    expect(consumerRef.current!.contextValue).toBe(20);
    expect(consumerRef.current!.props.label).toBe('b');
    expect(consumerRef.current!.lastSeenProps).toEqual({ label: 'b' });
    expect(consumerRef.current!.lastSeenContext).toBe(20);
    expect(consumerRef.current!.onUpdateCallCount).toBe(1);

    await runtime.unmount();
  });

  it('context update combined with local state update', async () => {
    class Consumer extends Component<{ count: number }, Record<string, never>> {
      @UseContext(TEST_CONTEXT)
      public contextValue = -1;

      public onUpdateCallCount = 0;

      constructor (props: Record<string, never>) {
        super(props, { count: 0 });
      }

      public increment (): void {
        this.setState({ count: this.state.count + 1 });
      }

      public override onUpdate (): void {
        this.onUpdateCallCount += 1;
      }
    }

    class Root extends Component<Record<string, never>, { contextVal: number }> {
      @UseRef()
      private declare consumerRef: RefObject<Consumer>;

      constructor (props: { contextVal: number }) {
        super(props);
      }

      public getConsumerRef (): RefObject<Consumer> {
        return this.consumerRef;
      }

      public override compose (): VirtualServiceNode[] {
        return [
          h(ContextProvider, { value: [TEST_CONTEXT, this.props.contextVal] }, [
            h(Consumer, {}, this.consumerRef),
          ]),
        ];
      }
    }

    const runtime = await GraphRuntime.mount(h(Root, { contextVal: 10 }));

    const root = runtime.getRootInstance() as Root | null;
    expect(root).not.toBeNull();

    const consumerRef = root!.getConsumerRef();
    expect(consumerRef.current).not.toBeNull();

    expect(consumerRef.current!.contextValue).toBe(10);
    expect(consumerRef.current!.state.count).toBe(0);

    consumerRef.current!.increment();
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        resolve();
      });
    });

    expect(consumerRef.current!.state.count).toBe(1);
    expect(consumerRef.current!.onUpdateCallCount).toBe(1);

    await runtime.reconcile(h(Root, { contextVal: 20 }));

    expect(consumerRef.current!.contextValue).toBe(20);
    expect(consumerRef.current!.state.count).toBe(1);
    expect(consumerRef.current!.onUpdateCallCount).toBe(2);

    await runtime.unmount();
  });

  it('same-scope skip: props-only update does not re-resolve context', async () => {
    class Consumer extends Component<Record<string, never>, { label: string }> {
      @UseContext(TEST_CONTEXT)
      public contextValue = -1;

      public onUpdateCallCount = 0;
      public lastPropsLabel: string | undefined;

      constructor (props: { label: string }) {
        super(props);
      }

      public override onUpdate (): void {
        this.onUpdateCallCount += 1;
        this.lastPropsLabel = this.props.label;
      }
    }

    class Root extends Component<Record<string, never>, { consumerLabel: string }> {
      @UseRef()
      private declare consumerRef: RefObject<Consumer>;

      constructor (props: { consumerLabel: string }) {
        super(props);
      }

      public getConsumerRef (): RefObject<Consumer> {
        return this.consumerRef;
      }

      public override compose (): VirtualServiceNode[] {
        return [
          h(ContextProvider, { value: [TEST_CONTEXT, 100] }, [
            h(Consumer, { label: this.props.consumerLabel }, this.consumerRef),
          ]),
        ];
      }
    }

    const runtime = await GraphRuntime.mount(h(Root, { consumerLabel: 'a' }));

    const root = runtime.getRootInstance() as Root | null;
    expect(root).not.toBeNull();

    const consumerRef = root!.getConsumerRef();
    expect(consumerRef.current).not.toBeNull();

    const initialContextValue = consumerRef.current!.contextValue;
    expect(initialContextValue).toBe(100);
    expect(consumerRef.current!.onUpdateCallCount).toBe(0);

    await runtime.reconcile(h(Root, { consumerLabel: 'b' }));

    expect(consumerRef.current!.contextValue).toBe(initialContextValue);
    expect(consumerRef.current!.lastPropsLabel).toBe('b');
    expect(consumerRef.current!.onUpdateCallCount).toBe(1);

    await runtime.unmount();
  });

  it('same-scope skip: local setState does not re-resolve context', async () => {
    class Consumer extends Component<{ count: number }, Record<string, never>> {
      @UseContext(TEST_CONTEXT)
      public contextValue = -1;

      public onUpdateCallCount = 0;

      constructor (props: Record<string, never>) {
        super(props, { count: 0 });
      }

      public increment (): void {
        this.setState({ count: this.state.count + 1 });
      }

      public override onUpdate (): void {
        this.onUpdateCallCount += 1;
      }
    }

    class Root extends Component<Record<string, never>, Record<string, never>> {
      @UseRef()
      private declare consumerRef: RefObject<Consumer>;

      constructor () {
        super({});
      }

      public getConsumerRef (): RefObject<Consumer> {
        return this.consumerRef;
      }

      public override compose (): VirtualServiceNode[] {
        return [
          h(ContextProvider, { value: [TEST_CONTEXT, 100] }, [
            h(Consumer, {}, this.consumerRef),
          ]),
        ];
      }
    }

    const runtime = await GraphRuntime.mount(h(Root, {}));

    const root = runtime.getRootInstance() as Root | null;
    expect(root).not.toBeNull();

    const consumerRef = root!.getConsumerRef();
    expect(consumerRef.current).not.toBeNull();

    const initialContextValue = consumerRef.current!.contextValue;
    expect(initialContextValue).toBe(100);
    expect(consumerRef.current!.state.count).toBe(0);

    consumerRef.current!.increment();
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        resolve();
      });
    });

    expect(consumerRef.current!.state.count).toBe(1);
    expect(consumerRef.current!.contextValue).toBe(initialContextValue);
    expect(consumerRef.current!.onUpdateCallCount).toBe(1);

    await runtime.unmount();
  });

  it('consumer deleted in same reconcile as provider value change', async () => {
    class Consumer extends Component<Record<string, never>, { id: string }> {
      @UseContext(TEST_CONTEXT)
      public contextValue = -1;

      public mountCount = 0;

      constructor (props: { id: string }) {
        super(props);
      }

      public override onMount (): void {
        this.mountCount += 1;
      }
    }

    class Root extends Component<Record<string, never>, { consumerIds: string[]; providerValue: number }> {
      @UseRef()
      private declare consumer1Ref: RefObject<Consumer>;

      @UseRef()
      private declare consumer2Ref: RefObject<Consumer>;

      constructor (props: { consumerIds: string[]; providerValue: number }) {
        super(props);
      }

      public getConsumer1Ref (): RefObject<Consumer> {
        return this.consumer1Ref;
      }

      public getConsumer2Ref (): RefObject<Consumer> {
        return this.consumer2Ref;
      }

      public override compose (): VirtualServiceNode[] {
        const consumers: VirtualServiceNode[] = [];

        if (this.props.consumerIds.includes('c1')) {
          consumers.push(h(Consumer, { id: 'c1' }, this.consumer1Ref, 'c1'));
        }

        if (this.props.consumerIds.includes('c2')) {
          consumers.push(h(Consumer, { id: 'c2' }, this.consumer2Ref, 'c2'));
        }

        return [
          h(ContextProvider, { value: [TEST_CONTEXT, this.props.providerValue] }, consumers),
        ];
      }
    }

    const runtime = await GraphRuntime.mount(h(Root, { consumerIds: ['c1', 'c2'], providerValue: 10 }));

    const root = runtime.getRootInstance() as Root | null;
    expect(root).not.toBeNull();

    const consumer1Ref = root!.getConsumer1Ref();
    const consumer2Ref = root!.getConsumer2Ref();
    expect(consumer1Ref.current).not.toBeNull();
    expect(consumer2Ref.current).not.toBeNull();

    expect(consumer1Ref.current!.contextValue).toBe(10);
    expect(consumer2Ref.current!.contextValue).toBe(10);
    expect(consumer1Ref.current!.mountCount).toBe(1);
    expect(consumer2Ref.current!.mountCount).toBe(1);

    await runtime.reconcile(h(Root, { consumerIds: ['c1'], providerValue: 20 }));

    expect(consumer1Ref.current).not.toBeNull();
    expect(consumer1Ref.current!.contextValue).toBe(20);
    expect(consumer1Ref.current!.mountCount).toBe(1);

    expect(consumer2Ref.current).toBeNull();

    await runtime.unmount();
  });

  it('same token value identity after scope change does not extra-fire context onUpdate', async () => {
    const sharedValue = { id: 42 };

    class Consumer extends Component<Record<string, never>, { key: string }> {
      @UseContext(TEST_CONTEXT_A)
      public contextValue: unknown = null;

      public onUpdateCallCount = 0;
      public mountCount = 0;

      constructor (props: { key: string }) {
        super(props);
      }

      public override onMount (): void {
        this.mountCount += 1;
      }

      public override onUpdate (): void {
        this.onUpdateCallCount += 1;
      }
    }

    const stableProps = { key: 'stable' };
    const stableValue = [TEST_CONTEXT_A, sharedValue] as [typeof TEST_CONTEXT_A, typeof sharedValue];

    class Root extends Component<Record<string, never>, { dummyProp: number }> {
      @UseRef()
      private declare consumerRef: RefObject<Consumer>;

      constructor (props: { dummyProp: number }) {
        super(props);
      }

      public getConsumerRef (): RefObject<Consumer> {
        return this.consumerRef;
      }

      public override compose (): VirtualServiceNode[] {
        return [
          h(ContextProvider, { value: stableValue }, [
            h(Consumer, stableProps, this.consumerRef),
          ]),
        ];
      }
    }

    const runtime = await GraphRuntime.mount(h(Root, { dummyProp: 1 }));

    const root = runtime.getRootInstance() as Root | null;
    expect(root).not.toBeNull();

    const consumerRef = root!.getConsumerRef();
    expect(consumerRef.current).not.toBeNull();

    expect(consumerRef.current!.contextValue).toBe(sharedValue);
    expect(consumerRef.current!.mountCount).toBe(1);
    expect(consumerRef.current!.onUpdateCallCount).toBe(0);

    await runtime.reconcile(h(Root, { dummyProp: 2 }));

    expect(consumerRef.current!.contextValue).toBe(sharedValue);
    expect(consumerRef.current!.mountCount).toBe(1);
    expect(consumerRef.current!.onUpdateCallCount).toBe(0);

    await runtime.unmount();
  });
});
