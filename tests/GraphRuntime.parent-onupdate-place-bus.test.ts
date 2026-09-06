/**
 * Regression: parent `onUpdate` used to run before child reconcile, so a
 * publish in the same UPDATE pass was silently dropped by a PLACE child's
 * `@OnEvent` handler that was not wired yet.
 *
 * Distinct from #119 (sibling UPDATE then later PLACE in full-diff). This is
 * the parent→child edge inside `updateFiber`.
 */

import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { UseEventBus, OnEvent } from '../src/runtime/BusDecorators';

type Ev = { type: 'READY'; payload: { id: string } };

function makeBuses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus(),
    queryBus: new QueryBus(),
  };
}

describe('GraphRuntime parent onUpdate vs PLACE child bus', () => {
  it('parent.onUpdate publish reaches same-pass PLACE child @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Child extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ show: boolean }, { show: boolean }> {
      @UseEventBus() declare events: EventBus<Ev>;

      public override onUpdate (): void {
        this.events.publish({ type: 'READY', payload: { id: 'parent-update' } });
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
    expect(seen).toEqual(['parent-update']);
    await rt.unmount();
  });

  it('parent.onUpdate publish reaches nested PLACE grandchild @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Grandchild extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Mid extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        if (!this.props.show) {
          return [];
        }
        return [h(Grandchild, {}, 'g')];
      }
    }

    class Parent extends Component<{ show: boolean }, { show: boolean }> {
      @UseEventBus() declare events: EventBus<Ev>;

      public override onUpdate (): void {
        this.events.publish({ type: 'READY', payload: { id: 'nested' } });
      }

      public override compose () {
        return [h(Mid, { show: this.props.show }, 'm')];
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
    expect(seen).toEqual(['nested']);
    await rt.unmount();
  });
});
