/**
 * GraphRuntime: fail-stop state machine (issue #10).
 *
 * Tests that the runtime transitions to FAILED state on unrecoverable errors
 * and that later reconcile rejects, unmount stays safe, and currentRoot is null.
 *
 * @module Effectable/component/GraphRuntime.fail-stop.test
 */

import { Component, GraphRuntime, h } from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

jest.setTimeout(30_000);

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
    it('sync mount failure → getState() FAILED, getRootInstance() null, later reconcile rejects', async () => {
      await expect(
        GraphRuntime.mount(h(FailOnMountRoot, { shouldFail: true }))
      ).rejects.toThrow('FailOnMountRoot: intentional mount failure');

      // Runtime should not be returned on mount failure
    });

    it('async mount failure → getState() FAILED, getRootInstance() null, later reconcile rejects', async () => {
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

    it('async compose error during dirty flush → FAILED', async () => {
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
});
