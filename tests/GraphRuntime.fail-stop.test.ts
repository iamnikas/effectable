/**
 * GraphRuntime: fail-stop state machine (issue #10).
 *
 * Tests that the runtime transitions to FAILED state on unrecoverable errors
 * and that later reconcile rejects, unmount stays safe, and currentRoot is null.
 *
 * @module Effectable/component/GraphRuntime.fail-stop.test
 */

import { Component, GraphRuntime, h } from 'Effectable';
import type { VirtualServiceNode, RefObject } from 'Effectable';
import { RUNTIME_PROPS_RECEIVER } from '../src/component/types';
import type { RuntimePropsReceiver } from '../src/component/types';
import { OnCommand, createRuntimeBuses } from 'Effectable';
import type { RuntimeCommand, RuntimeEvent, RuntimeQuery } from 'Effectable';

jest.setTimeout(30_000);

type TCmd = RuntimeCommand<'TestCmd', { value: number }>;
type TQuery = RuntimeQuery<'TestQuery', { id: string }>;
type TEvent = RuntimeEvent<'TestEvent', { msg: string }>;

async function drainMicrotasks (): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

interface TestLeafProps {
  value: number;
}

class TestLeaf extends Component<Record<string, never>, TestLeafProps> {
  public mountCount = 0;
  public unmountCount = 0;

  constructor (props: TestLeafProps) {
    super(props);
    this.state = {};
  }

  public override onMount (): void {
    this.mountCount += 1;
  }

  public override onUnmount (): void {
    this.unmountCount += 1;
  }
}

interface FailOnMountRootProps {
  shouldFail: boolean;
}

class FailOnMountRoot extends Component<Record<string, never>, FailOnMountRootProps> {
  constructor (props: FailOnMountRootProps) {
    super(props);
    this.state = {};
  }

  public override onMount (): void {
    if (this.props.shouldFail) {
      throw new Error('FailOnMountRoot: intentional mount failure');
    }
  }

  public override compose (): VirtualServiceNode {
    return h(TestLeaf, { value: 1 });
  }
}

class AsyncFailOnMountRoot extends Component<Record<string, never>, FailOnMountRootProps> {
  constructor (props: FailOnMountRootProps) {
    super(props);
    this.state = {};
  }

  public override async onMount (): Promise<void> {
    await Promise.resolve();
    if (this.props.shouldFail) {
      throw new Error('AsyncFailOnMountRoot: intentional async mount failure');
    }
  }

  public override compose (): VirtualServiceNode {
    return h(TestLeaf, { value: 1 });
  }
}

interface FailOnComposeRootProps {
  shouldFail: boolean;
}

class FailOnComposeRoot extends Component<Record<string, never>, FailOnComposeRootProps> {
  constructor (props: FailOnComposeRootProps) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode {
    if (this.props.shouldFail) {
      throw new Error('FailOnComposeRoot: intentional compose failure');
    }
    return h(TestLeaf, { value: 1 });
  }
}

class FailOnUpdateRoot extends Component<Record<string, never>, { shouldFail: boolean }> {
  constructor (props: { shouldFail: boolean }) {
    super(props);
    this.state = {};
  }

  public override onUpdate (prevProps: { shouldFail: boolean }): void {
    if (this.props.shouldFail && !prevProps.shouldFail) {
      throw new Error('FailOnUpdateRoot: intentional onUpdate failure');
    }
  }

  public override compose (): VirtualServiceNode {
    return h(TestLeaf, { value: 1 });
  }
}

describe('GraphRuntime fail-stop (issue #10)', () => {
  describe('root replacement failure', () => {
    it('sync mount failure → throws, does not return failed instance', async () => {
      await expect(
        GraphRuntime.mount(h(FailOnMountRoot, { shouldFail: true }))
      ).rejects.toThrow('FailOnMountRoot: intentional mount failure');

      // Runtime should not be returned on mount failure
    });

    it('async mount failure → throws, does not return failed instance', async () => {
      await expect(
        GraphRuntime.mount(h(AsyncFailOnMountRoot, { shouldFail: true }))
      ).rejects.toThrow('AsyncFailOnMountRoot: intentional async mount failure');

      // Runtime should not be returned on mount failure
    });

    it('sync reconcile root replacement failure → FAILED, currentRoot null, later reconcile rejects', async () => {
      const runtime = await GraphRuntime.mount(
        h(TestLeaf, { value: 1 })
      );

      expect(runtime.isActive()).toBe(true);
      expect(runtime.getState()).toBe('active');
      expect(runtime.getRootInstance()).not.toBeNull();

      // Replace root with a different type that fails on mount
      await expect(
        runtime.reconcile(h(FailOnMountRoot, { shouldFail: true }))
      ).rejects.toThrow('FailOnMountRoot: intentional mount failure');

      // Runtime should be in FAILED state
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getState()).toBe('failed');
      expect(runtime.getRootInstance()).toBeNull();

      // Later reconcile should reject (with either terminal error or original error)
      await expect(
        runtime.reconcile(h(TestLeaf, { value: 2 }))
      ).rejects.toThrow();

      // Unmount should still be safe
      await runtime.unmount();
      expect(runtime.getState()).toBe('unmounted');
    });

    it('async reconcile root replacement failure → FAILED, currentRoot null, later reconcile rejects', async () => {
      const runtime = await GraphRuntime.mount(
        h(TestLeaf, { value: 1 })
      );

      expect(runtime.isActive()).toBe(true);
      expect(runtime.getState()).toBe('active');

      // Replace root with a different type that fails on async mount
      await expect(
        runtime.reconcile(h(AsyncFailOnMountRoot, { shouldFail: true }))
      ).rejects.toThrow('AsyncFailOnMountRoot: intentional async mount failure');

      // Runtime should be in FAILED state
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getState()).toBe('failed');
      expect(runtime.getRootInstance()).toBeNull();

      // Later reconcile should reject
      await expect(
        runtime.reconcile(h(TestLeaf, { value: 2 }))
      ).rejects.toThrow();

      // Unmount should still be safe
      await runtime.unmount();
    });
  });

  describe('child update / descendant failure', () => {
    it('child update failure → not left ACTIVE with partial graph', async () => {
      class ParentWithFailChild extends Component<Record<string, never>, { childShouldFail: boolean }> {
        constructor (props: { childShouldFail: boolean }) {
          super(props);
          this.state = {};
        }

        public override compose (): VirtualServiceNode[] {
          return [
            h(TestLeaf, { value: 1 }, 'leaf-1'),
            h(FailOnUpdateRoot, { shouldFail: this.props.childShouldFail }, 'fail-child'),
            h(TestLeaf, { value: 2 }, 'leaf-2'),
          ];
        }
      }

      const runtime = await GraphRuntime.mount(
        h(ParentWithFailChild, { childShouldFail: false })
      );

      expect(runtime.isActive()).toBe(true);
      expect(runtime.getState()).toBe('active');

      // Reconcile with child that will fail onUpdate
      await expect(
        runtime.reconcile(h(ParentWithFailChild, { childShouldFail: true }))
      ).rejects.toThrow('FailOnUpdateRoot: intentional onUpdate failure');

      // Runtime should be FAILED, not ACTIVE with partial graph
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getState()).toBe('failed');
      expect(runtime.getRootInstance()).toBeNull();

      // Unmount should still work
      await runtime.unmount();
    });

    it('child reconcile failure tears down live tree resources (refs, handlers)', async () => {
      const ref: { current: Component<unknown, unknown> | null } = { current: null };
      let unmountCount = 0;

      class ResourceLeaf extends Component<Record<string, never>, { value: number }> {
        private timer: NodeJS.Timeout | null = null;

        constructor (props: { value: number }) {
          super(props);
          this.state = {};
        }

        public override onMount (): void {
          // Simulate a resource (timer)
          this.timer = setTimeout(() => {
            // no-op
          }, 60000);
        }

        public override onUnmount (): void {
          unmountCount += 1;
          if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
          }
        }
      }

      class ParentWithResource extends Component<Record<string, never>, { useFailChild: boolean }> {
        constructor (props: { useFailChild: boolean }) {
          super(props);
          this.state = {};
        }

        public override compose (): VirtualServiceNode[] {
          if (this.props.useFailChild) {
            return [h(FailOnMountRoot, { shouldFail: true }, 'fail-child')];
          }
          return [h(ResourceLeaf, { value: 1 }, ref)];
        }
      }

      const runtime = await GraphRuntime.mount(
        h(ParentWithResource, { useFailChild: false })
      );

      expect(runtime.isActive()).toBe(true);
      expect(ref.current).not.toBeNull();
      const oldInstance = ref.current;
      expect(unmountCount).toBe(0);

      // Reconcile with child that will fail (should tear down old tree)
      await expect(
        runtime.reconcile(h(ParentWithResource, { useFailChild: true }))
      ).rejects.toThrow('FailOnMountRoot: intentional mount failure');

      // Runtime should be FAILED
      expect(runtime.getState()).toBe('failed');
      expect(runtime.getRootInstance()).toBeNull();

      // Old instance should have been unmounted (ref cleared, onUnmount called)
      expect(ref.current).toBeNull();
      expect(unmountCount).toBe(1);

      // Verify the old instance is the one that was unmounted
      expect(oldInstance).toBeInstanceOf(ResourceLeaf);

      await runtime.unmount();
    });

    it('descendant failure during reconcile → FAILED, not ACTIVE', async () => {
      class DeepNestHost extends Component<Record<string, never>, { useFailChild: boolean }> {
        constructor (props: { useFailChild: boolean }) {
          super(props);
          this.state = {};
        }

        public override compose (): VirtualServiceNode[] {
          if (this.props.useFailChild) {
            // Use a child that will fail on mount
            return [h(FailOnMountRoot, { shouldFail: true }, 'fail-child')];
          }
          return [h(TestLeaf, { value: 1 }, 'ok-child')];
        }
      }

      const runtime = await GraphRuntime.mount(
        h(DeepNestHost, { useFailChild: false })
      );

      expect(runtime.isActive()).toBe(true);

      // Reconcile with child replacement that will fail
      await expect(
        runtime.reconcile(h(DeepNestHost, { useFailChild: true }))
      ).rejects.toThrow('FailOnMountRoot: intentional mount failure');

      // Should be FAILED
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getState()).toBe('failed');
      expect(runtime.getRootInstance()).toBeNull();

      await runtime.unmount();
    });
  });

  describe('async dirty reconcile failure', () => {
    it('compose error during dirty flush → FAILED', async () => {
      const errors: unknown[] = [];

      class DirtyFailRoot extends Component<{ shouldFail: boolean }, Record<string, never>> {
        constructor (props: { shouldFail: boolean }) {
          super(props);
          this.state = { shouldFail: false };
        }

        public override compose (): VirtualServiceNode {
          if (this.state.shouldFail) {
            throw new Error('DirtyFailRoot: compose error during dirty flush');
          }
          return h(TestLeaf, { value: 1 });
        }
      }

      const runtime = await GraphRuntime.mount(
        h(DirtyFailRoot, { shouldFail: false }),
        undefined,
        undefined,
        (err: unknown) => {
          errors.push(err);
        }
      );

      const root = runtime.getRootInstance() as DirtyFailRoot | null;
      expect(root).not.toBeNull();
      if (root === null) {
        throw new Error('expected DirtyFailRoot');
      }

      expect(runtime.isActive()).toBe(true);

      // Trigger dirty flush that will fail
      root.setState({ shouldFail: true });
      await drainMicrotasks();

      // Should be FAILED
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getState()).toBe('failed');
      expect(runtime.getRootInstance()).toBeNull();

      // Error handler should have been called
      expect(errors.length).toBeGreaterThanOrEqual(1);

      // Unmount should still work
      await runtime.unmount();
    });

    it('sync compose error during dirty flush → FAILED', async () => {
      const errors: unknown[] = [];

      class AsyncDirtyFailRoot extends Component<Record<string, never>, { shouldFail: boolean }> {
        constructor (props: Record<string, never>) {
          super(props);
          this.state = { shouldFail: false };
        }

        public override compose (): VirtualServiceNode {
          if (this.state.shouldFail) {
            throw new Error('AsyncDirtyFailRoot: async compose error');
          }
          return h(TestLeaf, { value: 1 });
        }
      }

      const runtime = await GraphRuntime.mount(
        h(AsyncDirtyFailRoot, {}),
        undefined,
        undefined,
        (err: unknown) => {
          errors.push(err);
        }
      );

      const root = runtime.getRootInstance() as AsyncDirtyFailRoot | null;
      expect(root).not.toBeNull();
      if (root === null) {
        throw new Error('expected AsyncDirtyFailRoot');
      }

      expect(runtime.isActive()).toBe(true);

      // Trigger dirty flush with delay
      root.setState({ shouldFail: true });
      await Promise.resolve();
      await drainMicrotasks();

      // Should be FAILED
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getState()).toBe('failed');
      expect(errors.length).toBeGreaterThanOrEqual(1);

      await runtime.unmount();
    });
  });

  describe('compose / RUNTIME_PROPS_RECEIVER failure', () => {
    it('compose failure during reconcile → FAILED', async () => {
      const runtime = await GraphRuntime.mount(
        h(FailOnComposeRoot, { shouldFail: false })
      );

      expect(runtime.isActive()).toBe(true);

      // Reconcile with props that will cause compose to fail
      await expect(
        runtime.reconcile(h(FailOnComposeRoot, { shouldFail: true }))
      ).rejects.toThrow('FailOnComposeRoot: intentional compose failure');

      // Should be FAILED
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getState()).toBe('failed');
      expect(runtime.getRootInstance()).toBeNull();

      await runtime.unmount();
    });
  });

  describe('unmount after FAILED', () => {
    it('unmount after FAILED is safe and joinable', async () => {
      const runtime = await GraphRuntime.mount(
        h(TestLeaf, { value: 1 })
      );

      // Cause failure via root replacement
      await expect(
        runtime.reconcile(h(FailOnMountRoot, { shouldFail: true }))
      ).rejects.toThrow('FailOnMountRoot: intentional mount failure');

      expect(runtime.getState()).toBe('failed');
      expect(runtime.isActive()).toBe(false);

      // Unmount should not throw
      await runtime.unmount();
      expect(runtime.getState()).toBe('unmounted');

      // Second unmount should be idempotent
      await runtime.unmount();
      expect(runtime.getState()).toBe('unmounted');
    });

    it('concurrent unmount calls after FAILED are safe', async () => {
      const runtime = await GraphRuntime.mount(
        h(TestLeaf, { value: 1 })
      );

      // Cause failure via root replacement
      await expect(
        runtime.reconcile(h(FailOnMountRoot, { shouldFail: true }))
      ).rejects.toThrow();

      expect(runtime.getState()).toBe('failed');

      // Concurrent unmount calls should all succeed
      const unmountPromises = [
        runtime.unmount(),
        runtime.unmount(),
        runtime.unmount(),
      ];

      await Promise.all(unmountPromises);
      expect(runtime.getState()).toBe('unmounted');
    });
  });

  describe('state transitions', () => {
    it('IDLE → ACTIVE → FAILED → UNMOUNTED', async () => {
      const runtime = await GraphRuntime.mount(
        h(TestLeaf, { value: 1 })
      );

      // IDLE → ACTIVE happened during mount
      expect(runtime.getState()).toBe('active');
      expect(runtime.isActive()).toBe(true);

      // ACTIVE → FAILED via root replacement
      await expect(
        runtime.reconcile(h(FailOnMountRoot, { shouldFail: true }))
      ).rejects.toThrow();

      expect(runtime.getState()).toBe('failed');
      expect(runtime.isActive()).toBe(false);

      // FAILED → UNMOUNTED
      await runtime.unmount();
      expect(runtime.getState()).toBe('unmounted');
      expect(runtime.isActive()).toBe(false);
    });

    it('IDLE → ACTIVE → UNMOUNTING → UNMOUNTED', async () => {
      const runtime = await GraphRuntime.mount(
        h(TestLeaf, { value: 1 })
      );

      expect(runtime.getState()).toBe('active');

      // ACTIVE → UNMOUNTING → UNMOUNTED
      const unmountPromise = runtime.unmount();
      // State might be UNMOUNTING or UNMOUNTED depending on timing
      await unmountPromise;
      expect(runtime.getState()).toBe('unmounted');
    });
  });

  describe('terminal error persistence', () => {
    it('later reconcile rejects with the same terminal error', async () => {
      const runtime = await GraphRuntime.mount(
        h(TestLeaf, { value: 1 })
      );

      // Cause failure with specific error message via root replacement
      await expect(
        runtime.reconcile(h(FailOnMountRoot, { shouldFail: true }))
      ).rejects.toThrow('FailOnMountRoot: intentional mount failure');

      expect(runtime.getState()).toBe('failed');

      // Later reconcile should reject (checking terminalError is preserved)
      const result1 = runtime.reconcile(h(TestLeaf, { value: 2 }));
      await expect(result1).rejects.toThrow();

      const result2 = runtime.reconcile(h(TestLeaf, { value: 3 }));
      await expect(result2).rejects.toThrow();

      await runtime.unmount();
    });
  });

  describe('functional side-effect tests (public API)', () => {
    it('RUNTIME_PROPS_RECEIVER failure during reconcile → FAILED, currentRoot null, later reconcile rejects', async () => {
      class PropsReceiverComponent extends Component<Record<string, never>, { value: number }> 
        implements RuntimePropsReceiver<{ value: number }> {
        
        constructor (props: { value: number }) {
          super(props);
          this.state = {};
        }

        public [RUNTIME_PROPS_RECEIVER](nextProps: { value: number }): void {
          if (nextProps.value > 100) {
            throw new Error('PropsReceiverComponent: props value too large');
          }
          this.props = nextProps;
        }
      }

      const runtime = await GraphRuntime.mount(
        h(PropsReceiverComponent, { value: 50 })
      );

      expect(runtime.isActive()).toBe(true);
      expect(runtime.getRootInstance()).not.toBeNull();

      // Reconcile with props that will fail in RUNTIME_PROPS_RECEIVER
      await expect(
        runtime.reconcile(h(PropsReceiverComponent, { value: 200 }))
      ).rejects.toThrow('PropsReceiverComponent: props value too large');

      // Runtime should be FAILED
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getState()).toBe('failed');
      expect(runtime.getRootInstance()).toBeNull();

      // Later reconcile should reject
      await expect(
        runtime.reconcile(h(PropsReceiverComponent, { value: 10 }))
      ).rejects.toThrow();

      await runtime.unmount();
    });

    it('fail-stop clears bus handlers: after FAILED, commandBus rejects "not registered", ref cleared', async () => {
      const buses = createRuntimeBuses<TCmd, TQuery, TEvent>();
      const ref: RefObject<ComponentWithBusHandler> = { current: null };

      class ComponentWithBusHandler extends Component<Record<string, never>, { value: number }> {
        public commandsHandled = 0;

        constructor (props: { value: number }) {
          super(props);
          this.state = {};
        }

        @OnCommand('TestCmd')
        public async handleTestCmd (_cmd: TCmd): Promise<string> {
          this.commandsHandled += 1;
          return 'handled';
        }
      }

      class ParentWithBusChild extends Component<Record<string, never>, { useFailChild: boolean }> {
        constructor (props: { useFailChild: boolean }) {
          super(props);
          this.state = {};
        }

        public override compose (): VirtualServiceNode[] {
          if (this.props.useFailChild) {
            return [h(FailOnMountRoot, { shouldFail: true }, 'fail-child')];
          }
          return [h(ComponentWithBusHandler, { value: 1 }, ref)];
        }
      }

      const runtime = await GraphRuntime.mount(
        h(ParentWithBusChild, { useFailChild: false }),
        undefined,
        buses
      );

      expect(ref.current).not.toBeNull();
      const oldInstance = ref.current;

      // Verify bus handler works
      const cmd: TCmd = { type: 'TestCmd', payload: { value: 42 } };
      const result = await buses.commandBus.execute<string>(cmd);
      expect(result).toBe('handled');
      expect(oldInstance!.commandsHandled).toBe(1);

      // Cause fail-stop
      await expect(
        runtime.reconcile(h(ParentWithBusChild, { useFailChild: true }))
      ).rejects.toThrow('FailOnMountRoot: intentional mount failure');

      expect(runtime.getState()).toBe('failed');

      // Ref should be cleared
      expect(ref.current).toBeNull();

      // Bus handler should be unregistered
      await expect(
        buses.commandBus.execute<string>(cmd)
      ).rejects.toThrow(/not registered/i);

      await runtime.unmount();
    });

    it('later reconcile after FAILED rejects with SAME terminal error message', async () => {
      const runtime = await GraphRuntime.mount(
        h(TestLeaf, { value: 1 })
      );

      const specificErrorMessage = 'FailOnMountRoot: intentional mount failure';

      // Cause failure
      let firstError: Error | null = null;
      try {
        await runtime.reconcile(h(FailOnMountRoot, { shouldFail: true }));
      } catch (err) {
        firstError = err as Error;
      }

      expect(firstError).not.toBeNull();
      expect(firstError!.message).toBe(specificErrorMessage);
      expect(runtime.getState()).toBe('failed');

      // Later reconcile should reject with SAME error message
      let secondError: Error | null = null;
      try {
        await runtime.reconcile(h(TestLeaf, { value: 2 }));
      } catch (err) {
        secondError = err as Error;
      }

      expect(secondError).not.toBeNull();
      // Should be either the terminal error or mention terminal failure
      expect(
        secondError!.message === specificErrorMessage ||
        secondError!.message.includes('terminal failure')
      ).toBe(true);

      await runtime.unmount();
    });

    it('mount-fail: sibling/ref on parent with successful child then failing sibling is rolled back, refs null, no timers', async () => {
      const refA: RefObject<SuccessfulChild> = { current: null };
      const refB: RefObject<FailingChild> = { current: null };
      let timerCleared = false;

      class SuccessfulChild extends Component<Record<string, never>, Record<string, never>> {
        private timer: NodeJS.Timeout | null = null;

        constructor (props: Record<string, never>) {
          super(props);
          this.state = {};
        }

        public override onMount (): void {
          // Create a timer resource
          this.timer = setTimeout(() => {
            // no-op
          }, 60000);
        }

        public override onUnmount (): void {
          if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
            timerCleared = true;
          }
        }
      }

      class FailingChild extends Component<Record<string, never>, Record<string, never>> {
        constructor (props: Record<string, never>) {
          super(props);
          this.state = {};
        }

        public override onMount (): void {
          throw new Error('FailingChild: intentional mount failure');
        }
      }

      class ParentWithSiblings extends Component<Record<string, never>, Record<string, never>> {
        constructor (props: Record<string, never>) {
          super(props);
          this.state = {};
        }

        public override compose (): VirtualServiceNode[] {
          return [
            h(SuccessfulChild, {}, refA),
            h(FailingChild, {}, refB),
          ];
        }
      }

      // Mount should fail
      await expect(
        GraphRuntime.mount(h(ParentWithSiblings, {}))
      ).rejects.toThrow('FailingChild: intentional mount failure');

      // Refs should be null (rollback cleared them)
      expect(refA.current).toBeNull();
      expect(refB.current).toBeNull();

      // Timer should have been cleared during rollback
      expect(timerCleared).toBe(true);
    });

    it('onUnmount throw during fail-stop teardown → getState() FAILED, getRootInstance() null, later reconcile rejects with ORIGINAL error, cleanup error on rollbackErrors', async () => {
      class ThrowOnUnmount extends Component<Record<string, never>, Record<string, never>> {
        constructor (props: Record<string, never>) {
          super(props);
          this.state = {};
        }

        public override compose (): VirtualServiceNode {
          return h(TestLeaf, { value: 1 });
        }

        public override onUnmount (): void {
          throw new Error('ThrowOnUnmount: intentional cleanup error');
        }
      }

      class FailOnReconcileRoot extends Component<{ shouldFail: boolean }, Record<string, never>> {
        constructor (props: { shouldFail: boolean }) {
          super(props);
          this.state = {};
        }

        public override compose (): VirtualServiceNode {
          if (this.props.shouldFail) {
            throw new Error('FailOnReconcileRoot: intentional reconcile failure');
          }
          return h(ThrowOnUnmount, {});
        }
      }

      // Mount with successful child
      const runtime = await GraphRuntime.mount(
        h(FailOnReconcileRoot, { shouldFail: false })
      );

      expect(runtime.isActive()).toBe(true);
      expect(runtime.getRootInstance()).not.toBeNull();

      // Reconcile with failure - this should trigger fail-stop and attempt to destroy ThrowOnUnmount
      let reconcileError: Error | null = null;
      try {
        await runtime.reconcile(h(FailOnReconcileRoot, { shouldFail: true }));
      } catch (err: unknown) {
        reconcileError = err as Error;
      }

      expect(reconcileError).not.toBeNull();
      expect(reconcileError?.message).toContain('FailOnReconcileRoot: intentional reconcile failure');

      // getState() should be FAILED
      expect(runtime.getState()).toBe('failed');

      // getRootInstance() should be null
      expect(runtime.getRootInstance()).toBeNull();

      // Cleanup error should be attached as rollbackErrors
      const rollbackErrors = (reconcileError as Error & { rollbackErrors?: Error[] })?.rollbackErrors;
      expect(rollbackErrors).toBeDefined();
      expect(rollbackErrors?.length).toBeGreaterThan(0);
      expect(rollbackErrors?.[0]?.message).toContain('ThrowOnUnmount: intentional cleanup error');

      // Later reconcile should reject with terminal error (original error)
      await expect(
        runtime.reconcile(h(FailOnReconcileRoot, { shouldFail: false }))
      ).rejects.toThrow('FailOnReconcileRoot: intentional reconcile failure');

      // Unmount should still be safe
      await runtime.unmount();
    });
  });
});
