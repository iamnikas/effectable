/**
 * Regression: materialize rollback must dispose parent bus wiring AFTER destroying
 * children (and parent failed-cleanup), matching destroyFiber order
 * (children → onUnmount → bus dispose). Otherwise child onUnmount publishes to
 * parent @OnEvent are silently dropped when parent onMount fails.
 *
 * @module Effectable/component/GraphRuntime.bus-rollback-order.test
 */
import { Component, GraphRuntime, h, OnEvent, UseEventBus, createRuntimeBuses } from 'Effectable';
import type { EventBus, RuntimeEvent } from 'Effectable';

type CleanupEvt = RuntimeEvent<'CHILD_CLEANUP', { id: string }>;

describe('GraphRuntime materialize rollback bus-dispose order', () => {
  it('PARENT-ONMOUNT-FAIL: child onUnmount publish still reaches parent @OnEvent (parity with normal unmount)', async () => {
    const buses = createRuntimeBuses();
    const seen: string[] = [];

    class Child extends Component {
      @UseEventBus()
      public declare events: EventBus;

      public override async onUnmount (): Promise<void> {
        this.events.publish({ type: 'CHILD_CLEANUP', payload: { id: 'child' } } as CleanupEvt);
      }
    }

    class Parent extends Component {
      @OnEvent('CHILD_CLEANUP')
      public onChildCleanup (e: CleanupEvt): void {
        seen.push(e.payload.id);
      }

      public override async onMount (): Promise<void> {
        throw new Error('Parent onMount failure');
      }

      public override compose () {
        return [h(Child)];
      }
    }

    await expect(
      GraphRuntime.mount(h(Parent), undefined, buses)
    ).rejects.toThrow('Parent onMount failure');

    // Expected: child onUnmount publish was delivered to parent handler before teardown
    // finished — same as normal unmount ordering (children → parent hooks → bus dispose).
    expect(seen).toEqual(['child']);
  });

  it('CONTROL: normal unmount delivers child onUnmount publish to parent @OnEvent', async () => {
    const buses = createRuntimeBuses();
    const seen: string[] = [];

    class Child extends Component {
      @UseEventBus()
      public declare events: EventBus;

      public override async onUnmount (): Promise<void> {
        this.events.publish({ type: 'CHILD_CLEANUP', payload: { id: 'child' } } as CleanupEvt);
      }
    }

    class Parent extends Component {
      @OnEvent('CHILD_CLEANUP')
      public onChildCleanup (e: CleanupEvt): void {
        seen.push(e.payload.id);
      }

      public override compose () {
        return [h(Child)];
      }
    }

    const rt = await GraphRuntime.mount(h(Parent), undefined, buses);
    await rt.unmount();
    expect(seen).toEqual(['child']);
  });
});
