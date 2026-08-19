/**
 * GraphRuntime: teardown observability (issue #20).
 *
 * Tests that cleanup errors are observable without blocking remaining cleanup steps.
 *
 * @module Effectable/component/GraphRuntime.teardown-observability.test
 */

import { Component, GraphRuntime, h } from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

describe('GraphRuntime teardown observability (issue #20)', () => {
  describe('shutdown with one onUnmount failure still cleans the rest', () => {
    interface FailUnmountProps {
      shouldFail: boolean;
      label: string;
    }

    class FailUnmountLeaf extends Component<Record<string, never>, FailUnmountProps> {
      public mountCalls = 0;

      public unmountCalls = 0;

      constructor (props: FailUnmountProps) {
        super(props);
        this.state = {};
      }

      public override onMount (): void {
        this.mountCalls += 1;
      }

      public override onUnmount (): void {
        this.unmountCalls += 1;
        if (this.props.shouldFail) {
          throw new Error(`onUnmount failed: ${this.props.label}`);
        }
      }
    }

    interface FailUnmountHostProps {
      children: Array<{ key: string; label: string; fail: boolean }>;
    }

    class FailUnmountHost extends Component<Record<string, never>, FailUnmountHostProps> {
      constructor (props: FailUnmountHostProps) {
        super(props);
        this.state = {};
      }

      public override compose (): VirtualServiceNode[] {
        return this.props.children.map((child) =>
          h(FailUnmountLeaf, { shouldFail: child.fail, label: child.label }, child.key),
        );
      }
    }

    it('default unmount() swallows cleanup errors and completes', async () => {
      const runtime = await GraphRuntime.mount(
        h(FailUnmountHost, {
          children: [
            { key: 'a', label: 'first', fail: false },
            { key: 'b', label: 'second', fail: true },
            { key: 'c', label: 'third', fail: false },
          ],
        }),
      );

      expect(runtime.isActive()).toBe(true);

      // Default unmount should resolve even with cleanup errors
      await expect(runtime.unmount()).resolves.toBeUndefined();
      expect(runtime.isActive()).toBe(false);
    });

    it('unmount({ rejectOnCleanupError: true }) exposes single cleanup error', async () => {
      const runtime = await GraphRuntime.mount(
        h(FailUnmountHost, {
          children: [
            { key: 'a', label: 'first', fail: false },
            { key: 'b', label: 'second', fail: true },
            { key: 'c', label: 'third', fail: false },
          ],
        }),
      );

      expect(runtime.isActive()).toBe(true);

      // Opt-in to error reporting should reject with the error
      await expect(runtime.unmount({ rejectOnCleanupError: true })).rejects.toThrow(
        'onUnmount failed: second',
      );

      expect(runtime.isActive()).toBe(false);
    });

    it('unmount({ rejectOnCleanupError: true }) exposes multiple cleanup errors via AggregateError', async () => {
      const runtime = await GraphRuntime.mount(
        h(FailUnmountHost, {
          children: [
            { key: 'a', label: 'first', fail: true },
            { key: 'b', label: 'second', fail: true },
            { key: 'c', label: 'third', fail: false },
          ],
        }),
      );

      expect(runtime.isActive()).toBe(true);

      try {
        await runtime.unmount({ rejectOnCleanupError: true });
        throw new Error('Expected unmount to reject');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(AggregateError);
        const aggError = error as AggregateError;
        expect(aggError.errors).toHaveLength(2);
        expect(aggError.errors[0]).toBeInstanceOf(Error);
        expect((aggError.errors[0] as Error).message).toContain('onUnmount failed');
        expect(aggError.errors[1]).toBeInstanceOf(Error);
        expect((aggError.errors[1] as Error).message).toContain('onUnmount failed');
      }

      expect(runtime.isActive()).toBe(false);
    });

    it('all children are cleaned up even when some fail', async () => {
      const instances: FailUnmountLeaf[] = [];
      const refA = { current: null as FailUnmountLeaf | null };
      const refB = { current: null as FailUnmountLeaf | null };
      const refC = { current: null as FailUnmountLeaf | null };

      class TrackingHost extends Component<Record<string, never>, FailUnmountHostProps> {
        constructor (props: FailUnmountHostProps) {
          super(props);
          this.state = {};
        }

        public override compose (): VirtualServiceNode[] {
          const refs = [refA, refB, refC];
          return this.props.children.map((child, idx) => {
            const node = h(
              FailUnmountLeaf,
              { shouldFail: child.fail, label: child.label },
              child.key,
            );
            node.ref = refs[idx];
            return node;
          });
        }
      }

      const runtime = await GraphRuntime.mount(
        h(TrackingHost, {
          children: [
            { key: 'a', label: 'first', fail: false },
            { key: 'b', label: 'second', fail: true },
            { key: 'c', label: 'third', fail: false },
          ],
        }),
      );

      expect(refA.current).not.toBeNull();
      expect(refB.current).not.toBeNull();
      expect(refC.current).not.toBeNull();

      if (refA.current) instances.push(refA.current);
      if (refB.current) instances.push(refB.current);
      if (refC.current) instances.push(refC.current);

      expect(instances).toHaveLength(3);
      expect(instances[0].mountCalls).toBe(1);
      expect(instances[1].mountCalls).toBe(1);
      expect(instances[2].mountCalls).toBe(1);

      // Unmount with default behavior (swallow errors)
      await runtime.unmount();

      // All three children should have been unmounted despite one throwing
      expect(instances[0].unmountCalls).toBe(1);
      expect(instances[1].unmountCalls).toBe(1);
      expect(instances[2].unmountCalls).toBe(1);

      // Refs should be cleared
      expect(refA.current).toBeNull();
      expect(refB.current).toBeNull();
      expect(refC.current).toBeNull();
    });
  });

  describe('concurrent shutdown joins one promise', () => {
    class SlowUnmountRoot extends Component<Record<string, never>, Record<string, never>> {
      public unmountStarted = false;

      public unmountCompleted = false;

      constructor (props: Record<string, never>) {
        super(props);
        this.state = {};
      }

      public override async onUnmount (): Promise<void> {
        this.unmountStarted = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        this.unmountCompleted = true;
      }

      public override compose (): null {
        return null;
      }
    }

    it('concurrent unmount() calls await the same promise and join in-flight unmount', async () => {
      const runtime = await GraphRuntime.mount(h(SlowUnmountRoot, {}));
      const root = runtime.getRootInstance() as SlowUnmountRoot | null;

      expect(root).not.toBeNull();
      expect(runtime.isActive()).toBe(true);

      if (root === null) {
        throw new Error('expected SlowUnmountRoot instance');
      }

      // Start first unmount
      const unmount1 = runtime.unmount();

      // Wait a bit to ensure first unmount has started and changed state
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      // At this point: runtime is UNMOUNTING/UNMOUNTED, but unmountCompleted should still be false
      expect(root.unmountCompleted).toBe(false);

      // Start second unmount - it must join the in-flight unmount
      const unmount2 = runtime.unmount();

      // Wait for both to complete
      await Promise.all([unmount1, unmount2]);

      // Now unmount should be completed
      expect(runtime.isActive()).toBe(false);
      expect(root.unmountStarted).toBe(true);
      expect(root.unmountCompleted).toBe(true);
    });

    it('third unmount() call after completion returns immediately', async () => {
      const runtime = await GraphRuntime.mount(h(SlowUnmountRoot, {}));
      const root = runtime.getRootInstance() as SlowUnmountRoot | null;

      expect(root).not.toBeNull();
      expect(runtime.isActive()).toBe(true);

      if (root === null) {
        throw new Error('expected SlowUnmountRoot instance');
      }

      // First unmount
      await runtime.unmount();

      expect(runtime.isActive()).toBe(false);
      expect(root.unmountCompleted).toBe(true);

      // Second unmount after completion should return immediately (no-op)
      const unmount2Start = Date.now();
      await runtime.unmount();
      const unmount2Duration = Date.now() - unmount2Start;

      // Should be essentially instant (< 5ms)
      expect(unmount2Duration).toBeLessThan(5);
    });
  });

  describe('deep tree with partial failures', () => {
    interface DeepFailProps {
      depth: number;
      failAt: number;
    }

    class DeepFailNode extends Component<Record<string, never>, DeepFailProps> {
      public unmountCalls = 0;

      constructor (props: DeepFailProps) {
        super(props);
        this.state = {};
      }

      public override onUnmount (): void {
        this.unmountCalls += 1;
        if (this.props.depth === this.props.failAt) {
          throw new Error(`deep unmount fail at depth ${String(this.props.depth)}`);
        }
      }

      public override compose (): VirtualServiceNode[] | null {
        if (this.props.depth <= 0) {
          return null;
        }

        return [
          h(DeepFailNode, {
            depth: this.props.depth - 1,
            failAt: this.props.failAt,
          }),
        ];
      }
    }

    it('deep tree cleanup continues despite mid-depth failure', async () => {
      const depth = 8;
      const failAt = 4;
      const runtime = await GraphRuntime.mount(h(DeepFailNode, { depth, failAt }));

      expect(runtime.isActive()).toBe(true);

      // Default unmount swallows the error
      await expect(runtime.unmount()).resolves.toBeUndefined();
      expect(runtime.isActive()).toBe(false);
    });

    it('deep tree cleanup error is observable with opt-in', async () => {
      const depth = 8;
      const failAt = 4;
      const runtime = await GraphRuntime.mount(h(DeepFailNode, { depth, failAt }));

      expect(runtime.isActive()).toBe(true);

      await expect(runtime.unmount({ rejectOnCleanupError: true })).rejects.toThrow(
        `deep unmount fail at depth ${String(failAt)}`,
      );

      expect(runtime.isActive()).toBe(false);
    });
  });
});
