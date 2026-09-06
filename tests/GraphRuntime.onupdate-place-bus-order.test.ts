/**
 * Regression: UPDATE onUpdate (and parent onUpdate) used to publish before
 * later PLACE siblings / children finished @On* bus wiring, so update-time
 * events were silently dropped — same class of hole as sibling onMount
 * deferral, different lifecycle hook.
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

describe('GraphRuntime onUpdate vs PLACE bus order', () => {
  it('sibling: UPDATE onUpdate publish reaches later PLACE @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Early extends Component<{ n: number }, { n: number }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (): void {
        this.events.publish({ type: 'READY', payload: { id: 'upd' } });
      }
    }

    class Late extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ n: number; showLate: boolean }, { n: number; showLate: boolean }> {
      public override compose () {
        if (!this.props.showLate) {
          return [h(Early, { n: this.props.n }, 'e')];
        }
        return [h(Early, { n: this.props.n }, 'e'), h(Late, {}, 'l')];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { n: 0, showLate: false }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { n: 1, showLate: true }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['upd']);
    await rt.unmount();
  });

  it('parent onUpdate publish reaches PLACE child @OnEvent', async () => {
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
        this.events.publish({ type: 'READY', payload: { id: 'parent' } });
      }
      public override compose () {
        return this.props.show ? [h(Child, {}, 'c')] : [];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { show: false }),
      undefined,
      buses as any,
    );
    await rt.reconcile(h(Parent, { show: true }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['parent']);
    await rt.unmount();
  });
});
