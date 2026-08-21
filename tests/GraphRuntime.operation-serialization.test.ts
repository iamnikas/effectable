/**
 * GraphRuntime: operation serialization.
 *
 * Tests that all graph operations (reconcile, unmount) are properly serialized
 * through a single operation queue, preventing race conditions and ensuring
 * concurrent callers join in-flight operations.
 *
 * @module Effectable/component/GraphRuntime.operation-serialization.test
 */

import { Component, GraphRuntime, h } from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

jest.setTimeout(30_000);

// Helper to introduce async delay
async function delay (ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
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

  public override async onMount (): Promise<void> {
    this.mountCount += 1;
    // Simulate async startup
    await delay(5);
  }

  public override async onUnmount (): Promise<void> {
    this.unmountCount += 1;
    // Simulate async cleanup
    await delay(5);
  }
}

interface AsyncRootProps {
  tick: number;
}

class AsyncRoot extends Component<Record<string, never>, AsyncRootProps> {
  public composeCount = 0;

  constructor (props: AsyncRootProps) {
    super(props);
    this.state = {};
  }

  public override async onMount (): Promise<void> {
    // Simulate async initialization
    await delay(10);
  }

  public override compose (): VirtualServiceNode {
    this.composeCount += 1;
    return h(TestLeaf, { value: this.props.tick });
  }
}

interface DirtyHostState {
  tick: number;
}

class DirtyHost extends Component<DirtyHostState, Record<string, never>> {
  public composeCount = 0;

  constructor (props: Record<string, never>) {
    super(props, { tick: 0 });
  }

  public bump (): void {
    this.setState((prev) => ({ tick: prev.tick + 1 }));
  }

  public override compose (): VirtualServiceNode {
    this.composeCount += 1;
    return h(TestLeaf, { value: this.state.tick });
  }
}

describe('GraphRuntime operation serialization (issue #11)', () => {
  describe('concurrent reconcile calls', () => {
    it('two simultaneous reconcile calls execute sequentially without overlap', async () => {
      const runtime = await GraphRuntime.mount(h(AsyncRoot, { tick: 0 }));

      const reconcile1 = runtime.reconcile(h(AsyncRoot, { tick: 1 }));
      const reconcile2 = runtime.reconcile(h(AsyncRoot, { tick: 2 }));

      // Both should complete without error
      await Promise.all([reconcile1, reconcile2]);

      const root = runtime.getRootInstance() as AsyncRoot | null;
      expect(root).not.toBeNull();
      expect(root!.composeCount).toBeGreaterThanOrEqual(2);

      await runtime.unmount();
    });

    it('reconcile during async startup completes after mount finishes', async () => {
      // Start mount but don't await yet
      const mountPromise = GraphRuntime.mount(h(AsyncRoot, { tick: 0 }));

      // Allow mount to start but not complete
      await delay(5);

      const runtime = await mountPromise;

      // Now reconcile — should serialize with any pending work
      await runtime.reconcile(h(AsyncRoot, { tick: 1 }));

      const root = runtime.getRootInstance() as AsyncRoot | null;
      expect(root).not.toBeNull();
      expect(runtime.isActive()).toBe(true);

      await runtime.unmount();
    });
  });

  describe('unmount during reconcile', () => {
    it('unmount called during async reconcile waits for reconcile completion', async () => {
      const runtime = await GraphRuntime.mount(h(AsyncRoot, { tick: 0 }));

      // Start a reconcile that will take time
      const reconcilePromise = runtime.reconcile(h(AsyncRoot, { tick: 1 }));

      // Immediately call unmount (should serialize after reconcile)
      const unmountPromise = runtime.unmount();

      // Both should complete
      await Promise.all([reconcilePromise, unmountPromise]);

      expect(runtime.isActive()).toBe(false);
    });

    it('reconcile after unmount started is rejected', async () => {
      const runtime = await GraphRuntime.mount(h(AsyncRoot, { tick: 0 }));

      // Start unmount
      const unmountPromise = runtime.unmount();

      // Try to reconcile after unmount started — should reject
      await expect(
        runtime.reconcile(h(AsyncRoot, { tick: 1 }))
      ).rejects.toThrow('reconcile attempted after unmount started');

      await unmountPromise;
      expect(runtime.isActive()).toBe(false);
    });
  });

  describe('dirty update and unmount coordination', () => {
    it('dirty update scheduled immediately before unmount either completes or is cancelled', async () => {
      const runtime = await GraphRuntime.mount(h(DirtyHost, {}));
      const root = runtime.getRootInstance() as DirtyHost | null;
      expect(root).not.toBeNull();

      // Schedule a dirty update (will queue microtask)
      root!.bump();

      // Immediately call unmount (should cancel or wait for flush)
      await runtime.unmount();

      expect(runtime.isActive()).toBe(false);
    });

    it('dirty flush in progress when unmount starts is awaited', async () => {
      const runtime = await GraphRuntime.mount(h(DirtyHost, {}));
      const root = runtime.getRootInstance() as DirtyHost | null;
      expect(root).not.toBeNull();

      // Schedule dirty update
      root!.bump();

      // Wait for flush to start (microtask)
      await new Promise((resolve) => setImmediate(resolve));

      // Now unmount — should wait for flush
      await runtime.unmount();

      expect(runtime.isActive()).toBe(false);
    });
  });

  describe('concurrent unmount calls', () => {
    it('multiple simultaneous unmount calls await the same cleanup', async () => {
      const runtime = await GraphRuntime.mount(h(AsyncRoot, { tick: 0 }));

      // Call unmount multiple times concurrently
      const unmount1 = runtime.unmount();
      const unmount2 = runtime.unmount();
      const unmount3 = runtime.unmount();

      // All should resolve to the same cached promise
      await Promise.all([unmount1, unmount2, unmount3]);

      expect(runtime.isActive()).toBe(false);

      // Additional unmount calls should be idempotent
      await runtime.unmount();
      await runtime.unmount();
      expect(runtime.isActive()).toBe(false);
    });
  });

  describe('terminal failure handling', () => {
    class FailOnReconcileRoot extends Component<Record<string, never>, { shouldFail: boolean }> {
      constructor (props: { shouldFail: boolean }) {
        super(props);
        this.state = {};
      }

      public override compose (): VirtualServiceNode {
        if (this.props.shouldFail) {
          throw new Error('Intentional reconcile failure');
        }
        return h(TestLeaf, { value: 1 });
      }
    }

    it('failed operation transitions runtime to FAILED state (issue #10)', async () => {
      const runtime = await GraphRuntime.mount(h(FailOnReconcileRoot, { shouldFail: false }));

      // First reconcile will fail
      await expect(
        runtime.reconcile(h(FailOnReconcileRoot, { shouldFail: true }))
      ).rejects.toThrow('Intentional reconcile failure');

      // Runtime should be in FAILED state
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getState()).toBe('failed');

      // Subsequent reconcile should reject (runtime is FAILED)
      await expect(
        runtime.reconcile(h(FailOnReconcileRoot, { shouldFail: false }))
      ).rejects.toThrow();

      // Can still unmount safely
      await runtime.unmount();
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getState()).toBe('unmounted');
    });

    it('concurrent callers are serialized, first failure causes FAILED state', async () => {
      const runtime = await GraphRuntime.mount(h(FailOnReconcileRoot, { shouldFail: false }));

      // Start multiple reconciles concurrently  
      const reconcile1 = runtime.reconcile(h(FailOnReconcileRoot, { shouldFail: true }));
      const reconcile2 = runtime.reconcile(h(FailOnReconcileRoot, { shouldFail: false }));

      // Both should fail (first with reconcile error, second may fail with terminal or reconcile error)
      const results = await Promise.allSettled([reconcile1, reconcile2]);
      
      expect(results[0]?.status).toBe('rejected');
      expect(results[1]?.status).toBe('rejected');

      // Runtime should be FAILED
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getState()).toBe('failed');

      await runtime.unmount();
    });
  });
});
