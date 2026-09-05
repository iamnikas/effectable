/**
 * Rollback tests for transactional fiber materialization.
 *
 * @module Effectable/component/GraphRuntime.materialization-rollback.test
 */

import { Component, GraphRuntime, h } from 'Effectable';
import type { RefObject, VirtualServiceNode } from 'Effectable';
import { OnCommand, createRuntimeBuses } from 'Effectable';
import type { RuntimeCommand, RuntimeEvent, RuntimeQuery } from 'Effectable';

type TCmd = RuntimeCommand<'TestCommand', { value: number }>;

class ChildA extends Component<Record<string, never>, Record<string, never>> {
  public mounted = false;

  public override async onMount (): Promise<void> {
    this.mounted = true;
  }

  public override async onUnmount (): Promise<void> {
    this.mounted = false;
  }
}

class ChildB extends Component<Record<string, never>, { shouldFail?: boolean; shouldFailOnMount?: boolean }> {
  public constructor (props: { shouldFail?: boolean; shouldFailOnMount?: boolean }) {
    super(props);
    if (props.shouldFail === true) {
      throw new Error('ChildB constructor failure');
    }
  }

  public override async onMount (): Promise<void> {
    if (this.props.shouldFailOnMount === true) {
      throw new Error('ChildB onMount failure');
    }
  }
}

class ParentWithChildren extends Component<Record<string, never>, { childBFails?: boolean; childBFailsOnMount?: boolean }> {
  public override compose () {
    return [
      h(ChildA),
      h(ChildB, { shouldFail: this.props.childBFails, shouldFailOnMount: this.props.childBFailsOnMount }),
    ];
  }
}

class AsyncChild extends Component<Record<string, never>, { shouldFail?: boolean }> {
  public override async onMount (): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (this.props.shouldFail === true) {
      throw new Error('AsyncChild onMount failure');
    }
  }
}

class ParentWithAsyncChildren extends Component<Record<string, never>, { secondAsync?: boolean }> {
  public override compose () {
    return [
      h(AsyncChild, {}),
      h(AsyncChild, { shouldFail: this.props.secondAsync }),
    ];
  }
}

class ParentWithStartupFailure extends Component<Record<string, never>, { shouldFail?: boolean }> {
  public override async onMount (): Promise<void> {
    if (this.props.shouldFail === true) {
      throw new Error('Parent onMount failure');
    }
  }

  public override compose () {
    return [h(ChildA), h(ChildA)];
  }
}

class ComponentWithRef extends Component<Record<string, never>, { shouldFail?: boolean }> {
  public value = 42;

  public override async onMount (): Promise<void> {
    if (this.props.shouldFail === true) {
      throw new Error('ComponentWithRef onMount failure');
    }
  }
}

class ParentWithRefBinding extends Component<Record<string, never>, { refChildFails?: boolean }> {
  public ref: RefObject<ComponentWithRef> = { current: null };

  public override compose () {
    return [h(ChildA), h(ComponentWithRef, { shouldFail: this.props.refChildFails }, this.ref)];
  }
}

class ComponentWithBusWiring extends Component<Record<string, never>, { value: number }> {
  @OnCommand('TestCommand')
  public async handleCommand (_cmd: TCmd): Promise<string> {
    return 'handled';
  }

  public override async onMount (): Promise<void> {
    if (this.props.value > 100) {
      throw new Error('ComponentWithBusWiring onMount failure');
    }
  }
}

class ParentWithBusWiring extends Component<Record<string, never>, { busChildFails?: boolean }> {
  public override compose () {
    return [h(ChildA), h(ComponentWithBusWiring, { value: this.props.busChildFails === true ? 200 : 50 })];
  }
}

class ChildWithCleanupFailure extends Component<Record<string, never>, Record<string, never>> {
  public override async onUnmount (): Promise<void> {
    throw new Error('ChildWithCleanupFailure onUnmount error');
  }
}

class ParentWithCleanupFailures extends Component<Record<string, never>, Record<string, never>> {
  public override compose () {
    return [h(ChildWithCleanupFailure, {}), h(ChildWithCleanupFailure, {}), h(ChildB, { shouldFailOnMount: true })];
  }
}

class ParentTrackingUnmountWithoutMount extends Component<
  Record<string, never>,
  { childBFailsOnMount?: boolean }
> {
  public static mountCount = 0;
  public static unmountCount = 0;

  public static reset (): void {
    ParentTrackingUnmountWithoutMount.mountCount = 0;
    ParentTrackingUnmountWithoutMount.unmountCount = 0;
  }

  public override onMount (): void {
    ParentTrackingUnmountWithoutMount.mountCount += 1;
  }

  public override onUnmount (): void {
    ParentTrackingUnmountWithoutMount.unmountCount += 1;
  }

  public override compose () {
    return [
      h(ChildA),
      h(ChildB, { shouldFailOnMount: this.props.childBFailsOnMount }),
    ];
  }
}

describe('GraphRuntime materialization rollback (issue #12)', () => {
  describe('synchronous child failure', () => {
    it('SYNC-CHILD: later sync child constructor fails → earlier sibling unmounted', async () => {
      let error: Error | null = null;

      try {
        await GraphRuntime.mount(h(ParentWithChildren, { childBFails: true }));
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toBe('ChildB constructor failure');
    });

    it('SYNC-CHILD-MOUNT: later sync child onMount fails → earlier sibling unmounted', async () => {
      let error: Error | null = null;

      try {
        await GraphRuntime.mount(h(ParentWithChildren, { childBFailsOnMount: true }));
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toBe('ChildB onMount failure');
    });

    it('PARENT-NOT-MOUNTED: later child onMount fails → parent onUnmount must not run', async () => {
      ParentTrackingUnmountWithoutMount.reset();
      let error: Error | null = null;

      try {
        await GraphRuntime.mount(
          h(ParentTrackingUnmountWithoutMount, { childBFailsOnMount: true }),
        );
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toBe('ChildB onMount failure');
      // Parent never reached runStartup / onMount (children mount first).
      expect(ParentTrackingUnmountWithoutMount.mountCount).toBe(0);
      // Regression: rollback used wasMounted=true and called onUnmount anyway.
      expect(ParentTrackingUnmountWithoutMount.unmountCount).toBe(0);
    });
  });

  describe('asynchronous child failure', () => {
    it('ASYNC-CHILD: later async child rejection → earlier sibling unmounted', async () => {
      let error: Error | null = null;

      try {
        await GraphRuntime.mount(h(ParentWithAsyncChildren, { secondAsync: true }));
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toBe('AsyncChild onMount failure');
    });
  });

  describe('parent startup failure after children mounted', () => {
    it('PARENT-AFTER-CHILDREN: parent onMount fails → all children unmounted', async () => {
      let error: Error | null = null;

      try {
        await GraphRuntime.mount(h(ParentWithStartupFailure, { shouldFail: true }));
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toBe('Parent onMount failure');
    });
  });

  describe('ref binding rollback', () => {
    it('REF-CLEAR: parent failure after ref bind → ref cleared', async () => {
      let error: Error | null = null;

      try {
        await GraphRuntime.mount(h(ParentWithRefBinding, { refChildFails: true }));
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toBe('ComponentWithRef onMount failure');
    });

    it('REF-IDENTITY: ref cleared after successful binding and failure', async () => {
      const testRef: RefObject<ComponentWithRef> = { current: null };

      class ParentWithTestRef extends Component<Record<string, never>, Record<string, never>> {
        public override compose () {
          return [h(ComponentWithRef, { shouldFail: true }, testRef)];
        }
      }

      let error: Error | null = null;
      try {
        await GraphRuntime.mount(h(ParentWithTestRef));
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(testRef.current).toBeNull();
    });
  });

  describe('bus wiring rollback', () => {
    it('BUS-CLEAR: parent failure after bus wiring → external bus handlers removed', async () => {
      const buses = createRuntimeBuses<RuntimeCommand, RuntimeQuery, RuntimeEvent>();
      let error: Error | null = null;

      try {
        await GraphRuntime.mount(h(ParentWithBusWiring, { busChildFails: true }), undefined, buses);
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toBe('ComponentWithBusWiring onMount failure');

      await expect(buses.commandBus.execute<string>({ type: 'TestCommand', payload: { value: 1 } } as RuntimeCommand))
        .rejects.toThrow('Command handler is not registered: TestCommand');
    });
  });

  describe('best-effort cleanup', () => {
    it('CLEANUP-CONTINUE: one child cleanup fails → remaining siblings still processed', async () => {
      let error: Error | null = null;

      try {
        await GraphRuntime.mount(h(ParentWithCleanupFailures));
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toBe('ChildB onMount failure');
    });
  });

  describe('idempotent rollback', () => {
    it('IDEMPOTENT: repeated rollback attempt is safe', async () => {
      let error: Error | null = null;

      try {
        await GraphRuntime.mount(h(ParentWithChildren, { childBFailsOnMount: true }));
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
    });
  });

  describe('primary error preservation', () => {
    it('PRIMARY-ERROR: materialization error remains observable', async () => {
      let error: Error | null = null;

      try {
        await GraphRuntime.mount(h(ParentWithCleanupFailures));
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toBe('ChildB onMount failure');
    });
  });

  describe('nested destroy continues after throwing ref clear', () => {
    function throwingClearRef<T> (label: string): RefObject<T> {
      let value: T | null = null;
      return {
        get current (): T | null {
          return value;
        },
        set current (next: T | null) {
          if (next === null && value !== null) {
            throw new Error(`ref clear failed: ${label}`);
          }
          value = next;
        },
      };
    }

    it('NESTED-REF-THROW: grandchild ref.current=null throw during mount rollback still unmounts remaining grandchildren', async () => {
      const unmountLog: string[] = [];

      class TrackingLeaf extends Component<Record<string, never>, { label: string }> {
        public override onUnmount (): void {
          unmountLog.push(this.props.label);
        }
      }

      const throwingRef = throwingClearRef<TrackingLeaf>('g1');

      class Mid extends Component<Record<string, never>, Record<string, never>> {
        public override compose (): VirtualServiceNode[] {
          return [
            h(TrackingLeaf, { label: 'g1' }, throwingRef),
            h(TrackingLeaf, { label: 'g2' }),
          ];
        }
      }

      class FailingParent extends Component<Record<string, never>, Record<string, never>> {
        public override onMount (): void {
          throw new Error('FailingParent onMount failure');
        }

        public override compose (): VirtualServiceNode[] {
          return [h(Mid)];
        }
      }

      await expect(GraphRuntime.mount(h(FailingParent))).rejects.toThrow(
        'FailingParent onMount failure'
      );

      expect(unmountLog).toEqual(['g1', 'g2']);
    });

    it('PLACE-ROLLBACK: failed PLACE during reconcile still unmounts remaining grandchildren after ref-clear throw', async () => {
      const unmountLog: string[] = [];

      class TrackingLeaf extends Component<Record<string, never>, { label: string }> {
        public override onUnmount (): void {
          unmountLog.push(this.props.label);
        }
      }

      const throwingRef = throwingClearRef<TrackingLeaf>('g1-place');

      class Mid extends Component<Record<string, never>, Record<string, never>> {
        public override compose (): VirtualServiceNode[] {
          return [
            h(TrackingLeaf, { label: 'g1' }, throwingRef),
            h(TrackingLeaf, { label: 'g2' }),
          ];
        }
      }

      class NestedHost extends Component<Record<string, never>, Record<string, never>> {
        public override onMount (): void {
          throw new Error('NestedHost onMount failure');
        }

        public override compose (): VirtualServiceNode[] {
          return [h(Mid)];
        }
      }

      class StableLeaf extends Component<Record<string, never>, Record<string, never>> {}

      class ReconcileParent extends Component<{ showNested: boolean }, Record<string, never>> {
        constructor (props: Record<string, never>) {
          super(props);
          this.state = { showNested: false };
        }

        public revealNested (): void {
          this.setState({ showNested: true });
        }

        public override compose (): VirtualServiceNode[] {
          if (!this.state.showNested) {
            return [h(StableLeaf)];
          }

          return [h(StableLeaf), h(NestedHost)];
        }
      }

      const parentRef: RefObject<ReconcileParent> = { current: null };
      const parentNode = h(ReconcileParent);
      parentNode.ref = parentRef;
      const runtime = await GraphRuntime.mount(parentNode);
      const parent = parentRef.current;

      if (parent === null) {
        throw new Error('expected ReconcileParent instance');
      }

      parent.revealNested();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(runtime.getState()).toBe('failed');
      expect(unmountLog).toEqual(['g1', 'g2']);

      await runtime.unmount();
    });
  });
});
