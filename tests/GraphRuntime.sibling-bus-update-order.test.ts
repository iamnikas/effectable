/**
 * Regression: #108 deferred PLACE/REPLACE onMount so later sibling @On* handlers
 * receive mount-time publishes. UPDATE still ran onUpdate during structure, before
 * later PLACE siblings finished bus wiring — so an onUpdate publish in the same
 * reconcile pass was silently dropped.
 *
 * Distinct from sibling-bus-mount-order (#108): this is UPDATE onUpdate vs later PLACE.
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

describe('GraphRuntime sibling bus UPDATE onUpdate order', () => {
  it('later PLACE @OnEvent receives earlier sibling onUpdate publish', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Publisher extends Component<{ tick: number }, { tick: number }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (): void {
        this.events.publish({ type: 'READY', payload: { id: 'from-update' } });
      }
    }

    class Listener extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<
      { showListener: boolean; tick: number },
      { showListener: boolean; tick: number }
    > {
      public override compose () {
        if (!this.props.showListener) {
          return [h(Publisher, { tick: this.props.tick }, 'p')];
        }
        return [
          h(Publisher, { tick: this.props.tick }, 'p'),
          h(Listener, {}, 'l'),
        ];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { showListener: false, tick: 0 }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { showListener: true, tick: 1 }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['from-update']);
    await rt.unmount();
  });

  it('parent onUpdate publish reaches child PLACE @OnEvent in same reconcile', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Listener extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<
      { show: boolean; tick: number },
      { show: boolean; tick: number }
    > {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (): void {
        this.events.publish({ type: 'READY', payload: { id: 'parent-update' } });
      }
      public override compose () {
        return this.props.show ? [h(Listener, {}, 'l')] : [];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { show: false, tick: 0 }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { show: true, tick: 1 }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['parent-update']);
    await rt.unmount();
  });
});
