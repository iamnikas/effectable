/**
 * Critical: parent runtime-bus wiring currently runs after children materialize.
 * A child onMount publish to EventBus is silently dropped by parent @OnEvent.
 */
import {
  Component,
  GraphRuntime,
  OnEvent,
  UseEventBus,
  createRuntimeBuses,
  h,
  EMPTY_CONTEXT_SCOPE,
} from 'Effectable';
import type {
  RuntimeEvent,
  VirtualServiceNode,
} from 'Effectable';

describe('GraphRuntime parent bus before children materialize', () => {
  it('parent @OnEvent receives child onMount publish', async () => {
    type Buses = ReturnType<
      typeof createRuntimeBuses<never, never, RuntimeEvent<string, unknown>>
    >;

    class Child extends Component<Record<string, never>, Record<string, never>> {
      @UseEventBus()
      public eventBus!: Buses['eventBus'];

      public override onMount (): void {
        this.eventBus.publish({ type: 'CHILD_READY', payload: { ok: true } });
      }
    }

    class Parent extends Component<Record<string, never>, Record<string, never>> {
      public received: string[] = [];

      @OnEvent('CHILD_READY')
      public onChildReady (event: RuntimeEvent<string, unknown>): void {
        this.received.push(String(event.type));
      }

      public override compose (): VirtualServiceNode[] {
        return [h(Child)];
      }
    }

    const buses = createRuntimeBuses<never, never, RuntimeEvent<string, unknown>>();
    const runtime = await GraphRuntime.mount(h(Parent), EMPTY_CONTEXT_SCOPE, buses);
    const parent = runtime.getRootInstance() as Parent | null;

    expect(parent).not.toBeNull();
    expect(parent?.received).toEqual(['CHILD_READY']);

    await runtime.unmount();
  });
});
