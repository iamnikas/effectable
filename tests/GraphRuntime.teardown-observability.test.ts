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
    interface LatchedUnmountProps {
      release?: () => void;
    }

    class LatchedUnmountRoot extends Component<
      Record<string, never>,
      LatchedUnmountProps
    > {
      public unmountStarted = false;

      public unmountCompleted = false;

      public unmountCalls = 0;

      private release: (() => void) | null = null;

      constructor (props: LatchedUnmountProps) {
        super(props);
        this.state = {};
      }

      public override async onUnmount (): Promise<void> {
        this.unmountCalls += 1;
        this.unmountStarted = true;

        await new Promise<void>((resolve) => {
          this.release = () => {
            resolve();
          };
          if (this.props.release) {
            this.props.release();
          }
        });

        this.unmountCompleted = true;
      }

      public releaseUnmount (): void {
        if (this.release) {
          this.release();
        }
      }

      public override compose (): null {
        return null;
      }
    }

    it('concurrent unmount() calls await the same promise and join in-flight unmount', async () => {
      let releaseCalled = false;
      const runtime = await GraphRuntime.mount(
        h(LatchedUnmountRoot, {
          release: () => {
            releaseCalled = true;
          },
        }),
      );
      const root = runtime.getRootInstance() as LatchedUnmountRoot | null;

      expect(root).not.toBeNull();
      expect(runtime.isActive()).toBe(true);

      if (root === null) {
        throw new Error('expected LatchedUnmountRoot instance');
      }

      // Start first unmount
      const unmount1 = runtime.unmount();

      // Wait until unmount has started (onUnmount called release callback)
      while (!releaseCalled) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }

      // At this point: onUnmount is in-flight, but not completed
      expect(root.unmountStarted).toBe(true);
      expect(root.unmountCompleted).toBe(false);

      // Start second unmount - it must join the in-flight unmount
      const unmount2 = runtime.unmount();

      // Release the latch
      root.releaseUnmount();

      // Wait for both to complete
      await Promise.all([unmount1, unmount2]);

      // Now unmount should be completed, and onUnmount called only once
      expect(runtime.isActive()).toBe(false);
      expect(root.unmountStarted).toBe(true);
      expect(root.unmountCompleted).toBe(true);
      expect(root.unmountCalls).toBe(1);
    });

    it('third unmount() call after completion does not call onUnmount again', async () => {
      let releaseCalled = false;
      const runtime = await GraphRuntime.mount(
        h(LatchedUnmountRoot, {
          release: () => {
            releaseCalled = true;
          },
        }),
      );
      const root = runtime.getRootInstance() as LatchedUnmountRoot | null;

      expect(root).not.toBeNull();
      expect(runtime.isActive()).toBe(true);

      if (root === null) {
        throw new Error('expected LatchedUnmountRoot instance');
      }

      // Start first unmount
      const unmount1 = runtime.unmount();

      // Wait until unmount has started
      while (!releaseCalled) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }

      // Release the latch to let unmount complete
      root.releaseUnmount();
      await unmount1;

      expect(runtime.isActive()).toBe(false);
      expect(root.unmountCompleted).toBe(true);
      expect(root.unmountCalls).toBe(1);

      // Second unmount after completion should be a no-op
      await runtime.unmount();

      // onUnmount should not have been called again
      expect(root.unmountCalls).toBe(1);

      // Third unmount also a no-op
      await runtime.unmount();
      expect(root.unmountCalls).toBe(1);
    });

    it('concurrent join follows the first caller\'s options (mixed rejectOnCleanupError)', async () => {
      interface FailingUnmountProps {
        release?: () => void;
      }

      class FailingLatchedRoot extends Component<
        Record<string, never>,
        FailingUnmountProps
      > {
        public unmountStarted = false;

        public unmountCompleted = false;

        public unmountCalls = 0;

        private release: (() => void) | null = null;

        constructor (props: FailingUnmountProps) {
          super(props);
          this.state = {};
        }

        public override async onUnmount (): Promise<void> {
          this.unmountCalls += 1;
          this.unmountStarted = true;

          await new Promise<void>((resolve) => {
            this.release = () => {
              resolve();
            };
            if (this.props.release) {
              this.props.release();
            }
          });

          this.unmountCompleted = true;
          throw new Error('onUnmount cleanup error');
        }

        public releaseUnmount (): void {
          if (this.release) {
            this.release();
          }
        }

        public override compose (): null {
          return null;
        }
      }

      let releaseCalled = false;
      const runtime = await GraphRuntime.mount(
        h(FailingLatchedRoot, {
          release: () => {
            releaseCalled = true;
          },
        }),
      );
      const root = runtime.getRootInstance() as FailingLatchedRoot | null;

      expect(root).not.toBeNull();

      if (root === null) {
        throw new Error('expected FailingLatchedRoot instance');
      }

      // First caller: default (swallow errors)
      const unmount1 = runtime.unmount();

      // Wait until unmount has started
      while (!releaseCalled) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }

      expect(root.unmountStarted).toBe(true);
      expect(root.unmountCompleted).toBe(false);

      // Second caller: opt-in to rejection
      // But it should still RESOLVE because it joins the first caller's promise
      const unmount2 = runtime.unmount({ rejectOnCleanupError: true });

      // Release the latch
      root.releaseUnmount();

      // First caller resolves (swallows error)
      await expect(unmount1).resolves.toBeUndefined();

      // Second caller also resolves (follows first caller's options)
      // This documents current contract: concurrent join uses the first caller's options
      await expect(unmount2).resolves.toBeUndefined();

      // Cleanup still ran
      expect(root.unmountCalls).toBe(1);
      expect(runtime.isActive()).toBe(false);
    });
  });

  describe('deep tree with partial failures', () => {
    interface DeepFailProps {
      depth: number;
      failAt: number;
      tracker: Map<number, { unmountCalls: number; unmountOrder: number }>;
    }

    let unmountOrderCounter = 0;

    class DeepFailNode extends Component<Record<string, never>, DeepFailProps> {
      constructor (props: DeepFailProps) {
        super(props);
        this.state = {};
        this.props.tracker.set(this.props.depth, { unmountCalls: 0, unmountOrder: -1 });
      }

      public override onUnmount (): void {
        const entry = this.props.tracker.get(this.props.depth);
        if (entry) {
          entry.unmountCalls += 1;
          if (entry.unmountOrder === -1) {
            entry.unmountOrder = unmountOrderCounter++;
          }
        }

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
            tracker: this.props.tracker,
          }),
        ];
      }
    }

    it('deep tree cleanup continues despite mid-depth failure', async () => {
      const depth = 8;
      const failAt = 4;
      const tracker = new Map<number, { unmountCalls: number; unmountOrder: number }>();
      unmountOrderCounter = 0;

      const runtime = await GraphRuntime.mount(
        h(DeepFailNode, { depth, failAt, tracker }),
      );

      expect(runtime.isActive()).toBe(true);

      // Default unmount swallows the error
      await expect(runtime.unmount()).resolves.toBeUndefined();
      expect(runtime.isActive()).toBe(false);

      // Every depth 0..8 must have been unmounted exactly once
      for (let d = 0; d <= depth; d++) {
        const entry = tracker.get(d);
        expect(entry).toBeDefined();
        expect(entry!.unmountCalls).toBe(1);
      }

      // Children-before-parent order: depth 0 should unmount before depth 8
      const order0 = tracker.get(0)!.unmountOrder;
      const order8 = tracker.get(depth)!.unmountOrder;
      expect(order0).toBeLessThan(order8);

      // The failing node (depth 4) should also have been unmounted
      const failEntry = tracker.get(failAt);
      expect(failEntry).toBeDefined();
      expect(failEntry!.unmountCalls).toBe(1);
    });

    it('deep tree cleanup error is observable with opt-in', async () => {
      const depth = 8;
      const failAt = 4;
      const tracker = new Map<number, { unmountCalls: number; unmountOrder: number }>();
      unmountOrderCounter = 0;

      const runtime = await GraphRuntime.mount(
        h(DeepFailNode, { depth, failAt, tracker }),
      );

      expect(runtime.isActive()).toBe(true);

      await expect(runtime.unmount({ rejectOnCleanupError: true })).rejects.toThrow(
        `deep unmount fail at depth ${String(failAt)}`,
      );

      expect(runtime.isActive()).toBe(false);

      // Even with opt-in rejection, all depths must have been unmounted exactly once
      for (let d = 0; d <= depth; d++) {
        const entry = tracker.get(d);
        expect(entry).toBeDefined();
        expect(entry!.unmountCalls).toBe(1);
      }

      // Children-before-parent order still enforced
      const order0 = tracker.get(0)!.unmountOrder;
      const order8 = tracker.get(depth)!.unmountOrder;
      expect(order0).toBeLessThan(order8);

      // The failing node was unmounted and threw
      const failEntry = tracker.get(failAt);
      expect(failEntry).toBeDefined();
      expect(failEntry!.unmountCalls).toBe(1);
    });
  });
});
