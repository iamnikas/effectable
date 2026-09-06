/**
 * Regression: parent runtime-bus handlers must be registered BEFORE children
 * materialize. Child onMount may publish on the shared EventBus; if parent
 * @OnEvent is wired only after children, those events are silently dropped
 * while mount still succeeds (ACTIVE).
 *
 * @module Effectable/component/GraphRuntime.bus-mount-attach-order.test
 */
import { Component, GraphRuntime, h, OnEvent, UseEventBus, createRuntimeBuses } from 'Effectable';
import type { EventBus, RuntimeEvent } from 'Effectable';

type ReadyEvt = RuntimeEvent<'CHILD_READY', { id: string }>;

describe('GraphRuntime materialize bus-attach order', () => {
  it('child onMount publish reaches parent @OnEvent', async () => {
    const buses = createRuntimeBuses();
    const seen: string[] = [];

    class Child extends Component<Record<string, never>, Record<string, never>> {
      @UseEventBus()
      public declare events: EventBus;

      public override onMount (): void {
        this.events.publish({ type: 'CHILD_READY', payload: { id: 'c1' } } as ReadyEvt);
      }
    }

    class Parent extends Component<Record<string, never>, Record<string, never>> {
      @OnEvent('CHILD_READY')
      public onReady (e: ReadyEvt): void {
        seen.push(e.payload.id);
      }

      public override compose () {
        return [h(Child)];
      }
    }

    const rt = await GraphRuntime.mount(h(Parent), undefined, buses);
    expect(rt.getState()).toBe('active');
    expect(seen).toEqual(['c1']);
    await rt.unmount();
  });

  it('nested grandchild onMount publish reaches ancestor @OnEvent', async () => {
    const buses = createRuntimeBuses();
    const seen: string[] = [];

    class Grandchild extends Component<Record<string, never>, Record<string, never>> {
      @UseEventBus()
      public declare events: EventBus;

      public override onMount (): void {
        this.events.publish({ type: 'CHILD_READY', payload: { id: 'gc' } } as ReadyEvt);
      }
    }

    class Middle extends Component<Record<string, never>, Record<string, never>> {
      public override compose () {
        return [h(Grandchild)];
      }
    }

    class Root extends Component<Record<string, never>, Record<string, never>> {
      @OnEvent('CHILD_READY')
      public onReady (e: ReadyEvt): void {
        seen.push(e.payload.id);
      }

      public override compose () {
        return [h(Middle)];
      }
    }

    const rt = await GraphRuntime.mount(h(Root), undefined, buses);
    expect(rt.getState()).toBe('active');
    expect(seen).toEqual(['gc']);
    await rt.unmount();
  });
});
