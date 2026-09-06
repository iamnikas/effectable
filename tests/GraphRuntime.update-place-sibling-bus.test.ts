/**
 * Regression: in one reconcile batch, an UPDATE sibling's `onUpdate` publish must
 * reach a PLACE sibling's `@OnEvent` handlers.
 *
 * Full-diff reconcile used to run UPDATE (including onUpdate) before later PLACE
 * siblings finished bus wiring — silent event loss. Same severity class as the
 * #108 onMount/PLACE sibling deferral, but for the UPDATE+PLACE mix.
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

describe('GraphRuntime UPDATE onUpdate vs PLACE sibling bus', () => {
  it('keyed: UPDATE onUpdate publish reaches same-batch PLACE @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Publisher extends Component<{ n: number }, { n: number }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (prev: { n: number }): void {
        if (prev.n !== this.props.n) {
          this.events.publish({ type: 'READY', payload: { id: `n=${this.props.n}` } });
        }
      }
    }

    class Listener extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ n: number; show: boolean }, { n: number; show: boolean }> {
      public override compose () {
        if (!this.props.show) {
          return [h(Publisher, { n: this.props.n }, 'p')];
        }
        return [
          h(Publisher, { n: this.props.n }, 'p'),
          h(Listener, {}, 'l'),
        ];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { n: 1, show: false }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { n: 2, show: true }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['n=2']);
    await rt.unmount();
  });

  it('unkeyed positional: UPDATE onUpdate publish reaches same-batch PLACE @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Publisher extends Component<{ n: number }, { n: number }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (prev: { n: number }): void {
        if (prev.n !== this.props.n) {
          this.events.publish({ type: 'READY', payload: { id: `pos-${this.props.n}` } });
        }
      }
    }

    class Listener extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ n: number; show: boolean }, { n: number; show: boolean }> {
      public override compose () {
        if (!this.props.show) {
          return [h(Publisher, { n: this.props.n })];
        }
        return [
          h(Publisher, { n: this.props.n }),
          h(Listener, {}),
        ];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { n: 1, show: false }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { n: 3, show: true }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['pos-3']);
    await rt.unmount();
  });
});
