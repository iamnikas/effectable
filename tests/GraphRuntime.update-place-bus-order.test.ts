/**
 * Regression: sibling reconcile ran UPDATE `onUpdate` (and its publishes) before
 * later PLACE siblings finished `@On*` bus wiring, so reconcile-time events from
 * an updating publisher to a newly placed listener were silently dropped.
 *
 * #108 deferred PLACE/REPLACE `onMount` until peers wired, but left UPDATE
 * `onUpdate` inline in the left-to-right pass — this covers that remaining hole.
 *
 * Distinct from sibling-bus-mount-order (onMount↔onMount) and
 * parent-bus-before-children (#99).
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

describe('GraphRuntime UPDATE+PLACE sibling bus order', () => {
  it('PLACE @OnEvent receives earlier UPDATE sibling onUpdate publish', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Publisher extends Component<{ tick: number }, { tick: number }> {
      @UseEventBus() declare events: EventBus<Ev>;

      public override onUpdate (
        _prev: { tick: number },
        next: { tick: number },
      ): void {
        this.events.publish({ type: 'READY', payload: { id: `tick-${next.tick}` } });
      }
    }

    class Listener extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<
      { tick: number; showListener: boolean },
      { tick: number; showListener: boolean }
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
      h(Parent, { tick: 1, showListener: false }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { tick: 2, showListener: true }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['tick-2']);
    await rt.unmount();
  });

  it('stable UPDATE-only batch still runs onUpdate (no defer without PLACE)', async () => {
    const seen: number[] = [];
    const buses = makeBuses();

    class TickWatcher extends Component<{ tick: number }, { tick: number }> {
      public override onUpdate (
        _prev: { tick: number },
        next: { tick: number },
      ): void {
        seen.push(next.tick);
      }
    }

    class Parent extends Component<{ tick: number }, { tick: number }> {
      public override compose () {
        return [h(TickWatcher, { tick: this.props.tick }, 't')];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { tick: 1 }),
      undefined,
      buses as any,
    );
    await rt.reconcile(h(Parent, { tick: 2 }));
    await rt.reconcile(h(Parent, { tick: 3 }));
    expect(seen).toEqual([2, 3]);
    await rt.unmount();
  });
});
