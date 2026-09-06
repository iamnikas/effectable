/**
 * Regression: parent UPDATE `onUpdate` used to publish before same-pass child
 * PLACE finished `@On*` bus wiring — silent event drop. Distinct from sibling
 * UPDATE+PLACE ordering (#119): this is parent onUpdate before reconcileChildren.
 */

import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { UseEventBus, OnEvent } from '../src/runtime/BusDecorators';

type Ev = { type: 'PING'; payload: { id: string } };

function makeBuses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus(),
    queryBus: new QueryBus(),
  };
}

describe('GraphRuntime parent onUpdate vs child PLACE bus', () => {
  it('parent onUpdate publish reaches same-pass PLACE child @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Child extends Component {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ show: boolean }, { show: boolean }> {
      @UseEventBus() declare events: EventBus<Ev>;

      public override onUpdate (prev: { show: boolean }, next: { show: boolean }): void {
        if (!prev.show && next.show) {
          this.events.publish({ type: 'PING', payload: { id: 'parent' } });
        }
      }

      public override compose () {
        if (!this.props.show) {
          return [];
        }
        return [h(Child, {}, 'c')];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { show: false }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { show: true }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['parent']);
    await rt.unmount();
  });
});
