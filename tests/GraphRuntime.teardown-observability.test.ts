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

  describe('RED LOCKS: teardown holes that must be fixed', () => {
    // Hole 1: concurrent unmount must stay pending until destroy finishes
    it('HOLE 1: concurrent unmount stays pending while onUnmount executes (not just state check)', async () => {
      class LatchedUnmountRoot extends Component<
        Record<string, never>,
        { release?: () => void }
      > {
        public unmountStarted = false;

        public unmountCompleted = false;

        public unmountCalls = 0;

        private release: (() => void) | null = null;

        constructor (props: { release?: () => void }) {
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

      let releaseCalled = false;
      const runtime = await GraphRuntime.mount(
        h(LatchedUnmountRoot, {
          release: () => {
            releaseCalled = true;
          },
        }),
      );
      const root = runtime.getRootInstance() as LatchedUnmountRoot | null;

      if (root === null) {
        throw new Error('expected LatchedUnmountRoot instance');
      }

      // 1. Start first unmount
      const p1 = runtime.unmount();

      // 2. Wait until onUnmount started (latch released)
      while (!releaseCalled) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }

      // 3. At this point: onUnmount is in-flight but not completed
      expect(root.unmountStarted).toBe(true);
      expect(root.unmountCompleted).toBe(false);

      // 4. Start second unmount
      const p2 = runtime.unmount();

      // 5. Track if p2 settles
      let p2Settled = false;
      void p2.then(
        () => {
          p2Settled = true;
        },
        () => {
          p2Settled = true;
        },
      );

      // 6. Flush microtasks
      await Promise.resolve();
      await Promise.resolve();

      // 7. THE LOCK: p2 must NOT have settled yet while latch is held
      // This will FAIL because current code settles p2 immediately on state check
      expect(p2Settled).toBe(false);
      expect(root.unmountCompleted).toBe(false);

      // 8. Now release latch and verify both resolve, onUnmount called once
      root.releaseUnmount();
      await Promise.all([p1, p2]);

      expect(root.unmountCompleted).toBe(true);
      expect(root.unmountCalls).toBe(1);
    });

    // Hole 2: reconcile DELETE with throw in destroyFiber must not skip remaining orphans
    it('HOLE 2: reconcile DELETE orphans continues even if one ref.current=null throws', async () => {
      // Helper to create a ref that throws when cleared
      function throwingClearRef<T> (label: string) {
        let value: T | null = null;
        return {
          get current () {
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

      interface CountingLeafProps {
        label: string;
      }

      class CountingLeaf extends Component<Record<string, never>, CountingLeafProps> {
        public onMountCalls = 0;

        public onUnmountCalls = 0;

        constructor (props: CountingLeafProps) {
          super(props);
          this.state = {};
        }

        public override onMount (): void {
          this.onMountCalls += 1;
        }

        public override onUnmount (): void {
          this.onUnmountCalls += 1;
        }

        public override compose (): null {
          return null;
        }
      }

      interface HostProps {
        keys: string[];
      }

      const refA = { current: null as CountingLeaf | null };
      const refB = { current: null as CountingLeaf | null };
      const refC = throwingClearRef<CountingLeaf>('C');
      const refD = { current: null as CountingLeaf | null };
      const refE = { current: null as CountingLeaf | null };

      class Host extends Component<Record<string, never>, HostProps> {
        constructor (props: HostProps) {
          super(props);
          this.state = {};
        }

        public override compose (): VirtualServiceNode[] {
          const refs: Array<{ current: CountingLeaf | null }> = [
            refA,
            refB,
            refC,
            refD,
            refE,
          ];
          return this.props.keys.map((key, idx) => {
            const node = h(CountingLeaf, { label: key }, key);
            if (idx < refs.length) {
              node.ref = refs[idx];
            }
            return node;
          });
        }
      }

      // Mount with 5 children: a,b,c,d,e
      const runtime = await GraphRuntime.mount(h(Host, { keys: ['a', 'b', 'c', 'd', 'e'] }));

      expect(refA.current).not.toBeNull();
      expect(refB.current).not.toBeNull();
      expect(refC.current).not.toBeNull();
      expect(refD.current).not.toBeNull();
      expect(refE.current).not.toBeNull();

      const instanceB = refB.current!;
      const instanceC = refC.current!;
      const instanceD = refD.current!;
      const instanceE = refE.current!;

      // Reconcile to only child 'a' (orphans b,c,d,e)
      // This will trigger DELETE operations, and c's ref will throw during destroyFiber
      try {
        await runtime.reconcile(h(Host, { keys: ['a'] }));
      } catch {
        // Expected: ref clear for 'c' throws
      }

      // THE LOCK: ALL orphans must have run onUnmount, even though c's destroy threw
      // This will FAIL because current code fail-stops on c's throw and skips d,e
      expect(instanceB.onUnmountCalls).toBe(1);
      expect(instanceC.onUnmountCalls).toBe(1);
      expect(instanceD.onUnmountCalls).toBe(1);
      expect(instanceE.onUnmountCalls).toBe(1);

      // Child 'a' should still be mounted or cleaned consistently
      // (not testing 'a' survival requirement per spec, just that d/e were cleaned)
    });

    // Hole 3: partial PLACE then throw: newly materialized nodes must be unmounted
    it('HOLE 3: reconcile PLACE with mid-flight throw cleans up previously placed new nodes', async () => {
      interface LeafProps {
        key: string;
        shouldThrow: boolean;
      }

      const tracker = new Map<
        string,
        { onMountCalls: number; onUnmountCalls: number; instance: Component<any, any> }
      >();

      class TrackingLeaf extends Component<Record<string, never>, LeafProps> {
        constructor (props: LeafProps) {
          super(props);
          this.state = {};
          tracker.set(props.key, { onMountCalls: 0, onUnmountCalls: 0, instance: this });
        }

        public override onMount (): void {
          const entry = tracker.get(this.props.key)!;
          entry.onMountCalls += 1;

          if (this.props.shouldThrow) {
            throw new Error(`onMount throw: ${this.props.key}`);
          }
        }

        public override onUnmount (): void {
          const entry = tracker.get(this.props.key);
          if (entry) {
            entry.onUnmountCalls += 1;
          }
        }

        public override compose (): null {
          return null;
        }
      }

      interface HostProps {
        count: number;
        throwAt: number;
      }

      class Host extends Component<Record<string, never>, HostProps> {
        constructor (props: HostProps) {
          super(props);
          this.state = {};
        }

        public override compose (): VirtualServiceNode[] {
          const result: VirtualServiceNode[] = [];
          for (let i = 0; i < this.props.count; i++) {
            const key = `k${String(i)}`;
            const shouldThrow = i === this.props.throwAt;
            result.push(h(TrackingLeaf, { key, shouldThrow }, key));
          }
          return result;
        }
      }

      tracker.clear();

      // Mount with 2 children: k0, k1
      const runtime = await GraphRuntime.mount(h(Host, { count: 2, throwAt: -1 }));

      expect(tracker.get('k0')!.onMountCalls).toBe(1);
      expect(tracker.get('k1')!.onMountCalls).toBe(1);

      // Reconcile to 8 children: k0..k7, with k5 throwing in onMount
      try {
        await runtime.reconcile(h(Host, { count: 8, throwAt: 5 }));
      } catch {
        // Expected: k5 throws during onMount
      }

      // THE LOCK: newly PLACE'd children that mounted BEFORE k5 (k2, k3, k4)
      // must have been cleaned up (onUnmount === 1)
      // This will FAIL because current code does not clean up k2-k4
      const k0 = tracker.get('k0')!;
      const k1 = tracker.get('k1')!;
      const k2 = tracker.get('k2')!;
      const k3 = tracker.get('k3')!;
      const k4 = tracker.get('k4')!;
      const k5 = tracker.get('k5')!;

      // Old tree (k0, k1) should be cleaned by fail-stop
      expect(k0.onUnmountCalls).toBe(1);
      expect(k1.onUnmountCalls).toBe(1);

      // Newly placed k2-k4 must be cleaned
      expect(k2.onUnmountCalls).toBe(1);
      expect(k3.onUnmountCalls).toBe(1);
      expect(k4.onUnmountCalls).toBe(1);

      // k5 may have onUnmount 0 or 1 depending on engine (accept either, but not left ready)
      // We only care that k2-k4 are cleaned
      expect(k5.onMountCalls).toBe(1); // It tried to mount and threw

      // Later unmount should not be needed to rescue k2-k4
      // (runtime should be inactive or reconcile should have cleaned them)
    });
  });
});
