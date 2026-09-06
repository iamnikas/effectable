/**
 * Regression: REPLACE destroyed the old fiber (onUnmount) before a later PLACE
 * sibling finished @On* bus wiring in the same reconcile batch — teardown
 * publishes were silently dropped.
 *
 * Distinct from #108 (REPLACE/PLACE onMount defer) and #119/#126 (onUpdate vs PLACE).
 */

import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { UseEventBus, OnEvent } from '../src/runtime/BusDecorators';

type Ev = { type: 'BYE'; payload: { id: string } };

function makeBuses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus(),
    queryBus: new QueryBus(),
  };
}

describe('GraphRuntime REPLACE onUnmount before PLACE bus wiring', () => {
  it('keyed REPLACE victim onUnmount publish reaches later PLACE @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Victim extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'victim-unmount' } });
      }
    }

    class Replacement extends Component {}

    class LateListener extends Component {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ mode: 'a' | 'b' }, { mode: 'a' | 'b' }> {
      public override compose () {
        if (this.props.mode === 'a') {
          return [h(Victim, {}, 'slot')];
        }
        // key 'slot' REPLACE Victim→Replacement; key 'late' PLACE LateListener.
        // Without deferred REPLACE destroy, Victim.onUnmount runs before Late wires.
        return [h(Replacement, {}, 'slot'), h(LateListener, {}, 'late')];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { mode: 'a' }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { mode: 'b' }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['victim-unmount']);
    await rt.unmount();
  });

  it('unkeyed REPLACE victim onUnmount publish reaches later PLACE @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Victim extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'unkeyed-victim' } });
      }
    }

    class Other extends Component {}

    class LateListener extends Component {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ mode: 'a' | 'b' }, { mode: 'a' | 'b' }> {
      public override compose () {
        if (this.props.mode === 'a') {
          return [h(Victim, {})];
        }
        // Positional REPLACE Victim→Other, then PLACE LateListener.
        return [h(Other, {}), h(LateListener, {})];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { mode: 'a' }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { mode: 'b' }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['unkeyed-victim']);
    await rt.unmount();
  });
});
