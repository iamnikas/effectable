/**
 * Regression: sibling-batch REPLACE destroyed the victim immediately (running
 * onUnmount) before later PLACE siblings finished @On* bus wiring, so unmount
 * publishes were silently dropped. Distinct from #108 (onMount defer) and from
 * UPDATE onUpdate defer (#119 / sibling-bus-update-order).
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

describe('GraphRuntime sibling bus REPLACE onUnmount order', () => {
  it('later PLACE @OnEvent receives REPLACE victim onUnmount publish', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Leaving extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'READY', payload: { id: 'bye' } });
      }
    }

    class Replacement extends Component {}

    class Listener extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ mode: 'a' | 'b' }, { mode: 'a' | 'b' }> {
      public override compose () {
        if (this.props.mode === 'a') {
          return [h(Leaving, {}, 'x')];
        }
        // key x REPLACE Leaving→Replacement; key y PLACE Listener
        return [h(Replacement, {}, 'x'), h(Listener, {}, 'y')];
      }
    }

    const rt = await GraphRuntime.mount(h(Parent, { mode: 'a' }), undefined, buses as any);
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { mode: 'b' }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['bye']);
    await rt.unmount();
  });

  it('DELETE orphan onUnmount still reaches already-wired PLACE sibling', async () => {
    // Orphans are destroyed after the next-child loop (buses already wired);
    // this guards against regressing that working order while fixing REPLACE.
    const seen: string[] = [];
    const buses = makeBuses();

    class Leaving extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'READY', payload: { id: 'orphan-bye' } });
      }
    }

    class Listener extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ mode: 'a' | 'b' }, { mode: 'a' | 'b' }> {
      public override compose () {
        if (this.props.mode === 'a') {
          return [h(Leaving, {}, 'old')];
        }
        return [h(Listener, {}, 'new')];
      }
    }

    const rt = await GraphRuntime.mount(h(Parent, { mode: 'a' }), undefined, buses as any);
    await rt.reconcile(h(Parent, { mode: 'b' }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['orphan-bye']);
    await rt.unmount();
  });
});
