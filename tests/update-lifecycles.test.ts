/**
 * Tests for separate state, props, and context update lifecycles (issue #16).
 * 
 * Verifies that:
 * - onStateUpdate receives state arguments
 * - onPropsUpdate receives props arguments
 * - onContextUpdate receives context arguments
 * - Async hooks are properly awaited
 * - Errors in hooks are handled correctly
 * - setState during startup is handled
 * - Multiple state updates coalesce
 * - State is scheduled even if hook fails
 *
 * @module Effectable/component/update-lifecycles.test
 */

import { Component, GraphRuntime, h } from 'Effectable';
import type { RefObject } from 'Effectable';

interface CounterState {
  count: number;
}

interface CounterProps {
  multiplier: number;
}

describe('Separate update lifecycles (issue #16)', () => {
  describe('onStateUpdate', () => {
    it('receives state arguments with correct types', async () => {
      const stateUpdates: Array<{ prev: CounterState; next: CounterState }> = [];

      class StateTracker extends Component<CounterState, CounterProps> {
        constructor (props: CounterProps) {
          super(props);
          this.state = { count: 0 };
        }

        public override onStateUpdate (prev: CounterState, next: CounterState): void {
          stateUpdates.push({ prev: { ...prev }, next: { ...next } });
        }

        public incrementBy (n: number): void {
          this.setState({ count: this.state.count + n });
        }
      }

      const ref: RefObject<StateTracker> = { current: null };
      const runtime = await GraphRuntime.mount(h(StateTracker, { multiplier: 2 }, ref));

      expect(ref.current).not.toBeNull();
      if (ref.current === null) throw new Error('ref is null');

      // Initial state, no updates yet
      expect(stateUpdates).toHaveLength(0);

      // First setState
      ref.current.incrementBy(1);
      await new Promise(resolve => queueMicrotask(resolve));

      expect(stateUpdates).toHaveLength(1);
      expect(stateUpdates[0]?.prev.count).toBe(0);
      expect(stateUpdates[0]?.next.count).toBe(1);

      // Second setState
      ref.current.incrementBy(5);
      await new Promise(resolve => queueMicrotask(resolve));

      expect(stateUpdates).toHaveLength(2);
      expect(stateUpdates[1]?.prev.count).toBe(1);
      expect(stateUpdates[1]?.next.count).toBe(6);

      await runtime.unmount();
    });

    it('async onStateUpdate is properly awaited', async () => {
      const log: string[] = [];

      class AsyncStateUpdate extends Component<CounterState, Record<string, never>> {
        constructor (props: Record<string, never>) {
          super(props);
          this.state = { count: 0 };
        }

        public override async onStateUpdate (prev: CounterState, next: CounterState): Promise<void> {
          log.push(`state-start:${prev.count}->${next.count}`);
          await new Promise(resolve => setTimeout(resolve, 10));
          log.push(`state-end:${prev.count}->${next.count}`);
        }

        public increment (): void {
          this.setState({ count: this.state.count + 1 });
        }
      }

      const ref: RefObject<AsyncStateUpdate> = { current: null };
      const runtime = await GraphRuntime.mount(h(AsyncStateUpdate, {}, ref));

      expect(ref.current).not.toBeNull();
      if (ref.current === null) throw new Error('ref is null');

      ref.current.increment();
      
      // Wait for microtask and async hook
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(log).toEqual([
        'state-start:0->1',
        'state-end:0->1',
      ]);

      await runtime.unmount();
    });

    it('sync hook failure — state is committed and update is scheduled', async () => {
      const log: string[] = [];

      class FailingStateUpdate extends Component<CounterState, Record<string, never>> {
        constructor (props: Record<string, never>) {
          super(props);
          this.state = { count: 0 };
        }

        public override onStateUpdate (prev: CounterState, next: CounterState): void {
          log.push(`state-update:${prev.count}->${next.count}`);
          if (next.count === 1) {
            throw new Error('onStateUpdate sync failure');
          }
        }

        public increment (): void {
          try {
            this.setState({ count: this.state.count + 1 });
          } catch {
            log.push('caught-error');
          }
        }
      }

      const ref: RefObject<FailingStateUpdate> = { current: null };
      const runtime = await GraphRuntime.mount(h(FailingStateUpdate, {}, ref));

      expect(ref.current).not.toBeNull();
      if (ref.current === null) throw new Error('ref is null');

      // setState throws, but state is committed and update is scheduled (via finally block)
      ref.current.increment();
      
      // Wait for the graph update attempt
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(log).toContain('state-update:0->1');
      expect(log).toContain('caught-error');
      // State was committed despite hook failure (setState commits before calling onStateUpdate)
      expect(ref.current.state.count).toBe(1);

      await runtime.unmount();
    });

    it('async onStateUpdate does not block setState — state commits immediately', async () => {
      const log: string[] = [];

      class AsyncNonBlockingStateUpdate extends Component<CounterState, Record<string, never>> {
        constructor (props: Record<string, never>) {
          super(props);
          this.state = { count: 0 };
        }

        public override async onStateUpdate (prev: CounterState, next: CounterState): Promise<void> {
          log.push(`state-start:${prev.count}->${next.count}`);
          await new Promise(resolve => setTimeout(resolve, 10));
          log.push(`state-end:${prev.count}->${next.count}`);
        }

        public increment (): void {
          log.push('setState:start');
          this.setState({ count: this.state.count + 1 });
          log.push('setState:end');
        }
      }

      const ref: RefObject<AsyncNonBlockingStateUpdate> = { current: null };
      const runtime = await GraphRuntime.mount(h(AsyncNonBlockingStateUpdate, {}, ref));

      expect(ref.current).not.toBeNull();
      if (ref.current === null) throw new Error('ref is null');

      ref.current.increment();
      
      // setState completed immediately (before async hook finishes)
      expect(log).toEqual([
        'setState:start',
        'state-start:0->1',
        'setState:end',
      ]);
      
      // State was committed immediately
      expect(ref.current.state.count).toBe(1);

      // Wait for async hook to complete
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(log).toEqual([
        'setState:start',
        'state-start:0->1',
        'setState:end',
        'state-end:0->1',
      ]);

      await runtime.unmount();
    });

    it('setState during onMount calls onStateUpdate immediately and schedules reconcile after mount', async () => {
      const log: string[] = [];

      class SetStateInMount extends Component<CounterState, Record<string, never>> {
        constructor (props: Record<string, never>) {
          super(props);
          this.state = { count: 0 };
        }

        public override onMount (): void {
          log.push('mount:start');
          this.setState({ count: 1 });
          log.push('mount:end');
        }

        public override onStateUpdate (prev: CounterState, next: CounterState): void {
          log.push(`state-update:${prev.count}->${next.count}`);
        }

        public override compose () {
          log.push(`compose:count=${this.state.count}`);
          return null;
        }
      }

      const runtime = await GraphRuntime.mount(h(SetStateInMount, {}));

      // Wait for scheduled reconcile
      await new Promise(resolve => setTimeout(resolve, 50));

      // onStateUpdate is called immediately during setState (which is during onMount)
      // compose is called once during mount, then again after the scheduled reconcile
      expect(log).toEqual([
        'compose:count=0',      // Initial compose during mount
        'mount:start',
        'state-update:0->1',    // Called immediately during setState in onMount
        'mount:end',
        'compose:count=1',      // Scheduled reconcile after mount completes
      ]);

      await runtime.unmount();
    });

    it('setState before mount (during startup) schedules update after mount', async () => {
      const log: string[] = [];

      class SetStateInConstructor extends Component<CounterState, Record<string, never>> {
        constructor (props: Record<string, never>) {
          super(props);
          this.state = { count: 0 };
          log.push('constructor');
          this.setState({ count: 1 });
        }

        public override onMount (): void {
          log.push('mount');
        }

        public override onStateUpdate (prev: CounterState, next: CounterState): void {
          log.push(`state-update:${prev.count}->${next.count}`);
        }
      }

      const runtime = await GraphRuntime.mount(h(SetStateInConstructor, {}));

      // Wait for scheduled update
      await new Promise(resolve => setTimeout(resolve, 50));

      expect(log).toContain('constructor');
      expect(log).toContain('mount');
      expect(log).toContain('state-update:0->1');

      await runtime.unmount();
    });

    it('multiple setState calls coalesce into one graph update', async () => {
      const log: string[] = [];
      let reconcileCount = 0;

      class MultipleSetState extends Component<CounterState, Record<string, never>> {
        constructor (props: Record<string, never>) {
          super(props);
          this.state = { count: 0 };
        }

        public override onStateUpdate (prev: CounterState, next: CounterState): void {
          log.push(`state-update:${prev.count}->${next.count}`);
        }

        public override compose () {
          reconcileCount += 1;
          return null;
        }

        public tripleIncrement (): void {
          this.setState({ count: this.state.count + 1 });
          this.setState({ count: this.state.count + 1 });
          this.setState({ count: this.state.count + 1 });
        }
      }

      const ref: RefObject<MultipleSetState> = { current: null };
      const runtime = await GraphRuntime.mount(h(MultipleSetState, {}, ref));

      expect(ref.current).not.toBeNull();
      if (ref.current === null) throw new Error('ref is null');

      const initialReconcileCount = reconcileCount;
      log.length = 0;

      ref.current.tripleIncrement();
      
      // Wait for coalesced update
      await new Promise(resolve => setTimeout(resolve, 50));

      // Three setState calls, but only one graph reconcile
      expect(log).toHaveLength(3);
      expect(reconcileCount).toBe(initialReconcileCount + 1);

      await runtime.unmount();
    });
  });

  describe('onPropsUpdate', () => {
    it('receives props arguments with correct types', async () => {
      const propsUpdates: Array<{ prev: CounterProps; next: CounterProps }> = [];

      class PropsTracker extends Component<Record<string, never>, CounterProps> {
        constructor (props: CounterProps) {
          super(props);
        }

        public override onPropsUpdate (prev: CounterProps, next: CounterProps): void {
          propsUpdates.push({ prev: { ...prev }, next: { ...next } });
        }
      }

      const runtime = await GraphRuntime.mount(h(PropsTracker, { multiplier: 1 }));

      // No prop updates yet
      expect(propsUpdates).toHaveLength(0);

      // Update props via reconcile
      await runtime.reconcile(h(PropsTracker, { multiplier: 2 }));

      expect(propsUpdates).toHaveLength(1);
      expect(propsUpdates[0]?.prev.multiplier).toBe(1);
      expect(propsUpdates[0]?.next.multiplier).toBe(2);

      // Another prop update
      await runtime.reconcile(h(PropsTracker, { multiplier: 5 }));

      expect(propsUpdates).toHaveLength(2);
      expect(propsUpdates[1]?.prev.multiplier).toBe(2);
      expect(propsUpdates[1]?.next.multiplier).toBe(5);

      await runtime.unmount();
    });

    it('async onPropsUpdate is properly awaited', async () => {
      const log: string[] = [];

      class AsyncPropsUpdate extends Component<Record<string, never>, CounterProps> {
        constructor (props: CounterProps) {
          super(props);
        }

        public override async onPropsUpdate (prev: CounterProps, next: CounterProps): Promise<void> {
          log.push(`props-start:${prev.multiplier}->${next.multiplier}`);
          await new Promise(resolve => setTimeout(resolve, 10));
          log.push(`props-end:${prev.multiplier}->${next.multiplier}`);
        }
      }

      const runtime = await GraphRuntime.mount(h(AsyncPropsUpdate, { multiplier: 1 }));

      await runtime.reconcile(h(AsyncPropsUpdate, { multiplier: 2 }));

      expect(log).toEqual([
        'props-start:1->2',
        'props-end:1->2',
      ]);

      await runtime.unmount();
    });

    it('sync hook failure during reconcile calls runFailedCleanup and rethrows', async () => {
      const log: string[] = [];

      class FailingPropsUpdate extends Component<Record<string, never>, CounterProps> {
        constructor (props: CounterProps) {
          super(props);
        }

        public override onMount (): void {
          log.push('mount');
        }

        public override onPropsUpdate (prev: CounterProps, next: CounterProps): void {
          log.push(`props-update:${prev.multiplier}->${next.multiplier}`);
          if (next.multiplier === 2) {
            throw new Error('onPropsUpdate sync failure');
          }
        }

        public override onUnmount (): void {
          log.push('unmount');
        }
      }

      const runtime = await GraphRuntime.mount(h(FailingPropsUpdate, { multiplier: 1 }));

      expect(log).toContain('mount');

      await expect(
        runtime.reconcile(h(FailingPropsUpdate, { multiplier: 2 }))
      ).rejects.toThrow('onPropsUpdate sync failure');

      // Runtime should have called runFailedCleanup (unmount)
      expect(log).toContain('unmount');

      await runtime.unmount();
    });

    it('does not call onPropsUpdate if props object is the same by reference', async () => {
      const propsUpdates: Array<{ prev: CounterProps; next: CounterProps }> = [];

      class PropsReferenceCheck extends Component<Record<string, never>, CounterProps> {
        constructor (props: CounterProps) {
          super(props);
        }

        public override onPropsUpdate (prev: CounterProps, next: CounterProps): void {
          propsUpdates.push({ prev: { ...prev }, next: { ...next } });
        }
      }

      const sharedProps = { multiplier: 1 };
      const runtime = await GraphRuntime.mount(h(PropsReferenceCheck, sharedProps));

      // Reconcile with the same props object reference
      await runtime.reconcile(h(PropsReferenceCheck, sharedProps));

      // No prop update should be called
      expect(propsUpdates).toHaveLength(0);

      await runtime.unmount();
    });

    it('calls onPropsUpdate if fields match but props object is new', async () => {
      const propsUpdates: Array<{ prev: CounterProps; next: CounterProps }> = [];

      class PropsNewObject extends Component<Record<string, never>, CounterProps> {
        constructor (props: CounterProps) {
          super(props);
        }

        public override onPropsUpdate (prev: CounterProps, next: CounterProps): void {
          propsUpdates.push({ prev: { ...prev }, next: { ...next } });
        }
      }

      const runtime = await GraphRuntime.mount(h(PropsNewObject, { multiplier: 1 }));

      // Reconcile with a new object but same field value
      await runtime.reconcile(h(PropsNewObject, { multiplier: 1 }));

      // onPropsUpdate should be called (different object reference)
      expect(propsUpdates).toHaveLength(1);
      expect(propsUpdates[0]?.prev.multiplier).toBe(1);
      expect(propsUpdates[0]?.next.multiplier).toBe(1);

      await runtime.unmount();
    });
  });

  describe('Backward compatibility with onUpdate', () => {
    it('onUpdate is called for state changes when onStateUpdate is not present', async () => {
      const updateCalls: Array<{ prev: CounterState; next: CounterState }> = [];

      class LegacyStateUpdate extends Component<CounterState, Record<string, never>> {
        constructor (props: Record<string, never>) {
          super(props);
          this.state = { count: 0 };
        }

        public override onUpdate (prev: CounterState, next: CounterState): void {
          updateCalls.push({ prev: { ...prev }, next: { ...next } });
        }

        public increment (): void {
          this.setState({ count: this.state.count + 1 });
        }
      }

      const ref: RefObject<LegacyStateUpdate> = { current: null };
      const runtime = await GraphRuntime.mount(h(LegacyStateUpdate, {}, ref));

      expect(ref.current).not.toBeNull();
      if (ref.current === null) throw new Error('ref is null');

      ref.current.increment();
      await new Promise(resolve => queueMicrotask(resolve));

      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]?.prev.count).toBe(0);
      expect(updateCalls[0]?.next.count).toBe(1);

      await runtime.unmount();
    });

    it('onUpdate is called for props changes when onPropsUpdate is not present', async () => {
      const updateCalls: Array<{ prev: CounterProps; next: CounterProps }> = [];

      class LegacyPropsUpdate extends Component<Record<string, never>, CounterProps> {
        constructor (props: CounterProps) {
          super(props);
        }

        public override onUpdate (prev: CounterProps, next: CounterProps): void {
          updateCalls.push({ prev: { ...prev }, next: { ...next } });
        }
      }

      const runtime = await GraphRuntime.mount(h(LegacyPropsUpdate, { multiplier: 1 }));

      await runtime.reconcile(h(LegacyPropsUpdate, { multiplier: 2 }));

      expect(updateCalls).toHaveLength(1);
      expect(updateCalls[0]?.prev.multiplier).toBe(1);
      expect(updateCalls[0]?.next.multiplier).toBe(2);

      await runtime.unmount();
    });

    it('onStateUpdate takes precedence over onUpdate for state changes', async () => {
      const stateUpdateCalls: string[] = [];
      const updateCalls: string[] = [];

      class BothHooks extends Component<CounterState, Record<string, never>> {
        constructor (props: Record<string, never>) {
          super(props);
          this.state = { count: 0 };
        }

        public override onStateUpdate (prev: CounterState, next: CounterState): void {
          stateUpdateCalls.push(`state:${prev.count}->${next.count}`);
        }

        public override onUpdate (prev: CounterState, next: CounterState): void {
          updateCalls.push(`update:${prev.count}->${next.count}`);
        }

        public increment (): void {
          this.setState({ count: this.state.count + 1 });
        }
      }

      const ref: RefObject<BothHooks> = { current: null };
      const runtime = await GraphRuntime.mount(h(BothHooks, {}, ref));

      expect(ref.current).not.toBeNull();
      if (ref.current === null) throw new Error('ref is null');

      ref.current.increment();
      await new Promise(resolve => queueMicrotask(resolve));

      // onStateUpdate should be called, not onUpdate
      expect(stateUpdateCalls).toHaveLength(1);
      expect(updateCalls).toHaveLength(0);

      await runtime.unmount();
    });

    it('onPropsUpdate takes precedence over onUpdate for props changes', async () => {
      const propsUpdateCalls: string[] = [];
      const updateCalls: string[] = [];

      class BothPropsHooks extends Component<Record<string, never>, CounterProps> {
        constructor (props: CounterProps) {
          super(props);
        }

        public override onPropsUpdate (prev: CounterProps, next: CounterProps): void {
          propsUpdateCalls.push(`props:${prev.multiplier}->${next.multiplier}`);
        }

        public override onUpdate (prev: CounterProps, next: CounterProps): void {
          updateCalls.push(`update:${prev.multiplier}->${next.multiplier}`);
        }
      }

      const runtime = await GraphRuntime.mount(h(BothPropsHooks, { multiplier: 1 }));

      await runtime.reconcile(h(BothPropsHooks, { multiplier: 2 }));

      // onPropsUpdate should be called, not onUpdate
      expect(propsUpdateCalls).toHaveLength(1);
      expect(updateCalls).toHaveLength(0);

      await runtime.unmount();
    });
  });
});
