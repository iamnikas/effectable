/**
 * Regression: UPDATE `onUpdate` used to publish before later PLACE siblings
 * (and before same-pass PLACE children under an updating parent) finished
 * `@On*` bus wiring — events were silently dropped.
 *
 * Sibling onMount ordering is covered by #108 / sibling-bus-mount-order tests;
 * this file covers the onUpdate path that #108 did not defer.
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

describe('GraphRuntime onUpdate before PLACE bus wiring', () => {
  it('sibling UPDATE onUpdate publish reaches later PLACE @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Early extends Component<{ n: number }, { n: number }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (): void {
        this.events.publish({ type: 'READY', payload: { id: `n=${this.props.n}` } });
      }
    }

    class Late extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<
      { n: number; showLate: boolean },
      { n: number; showLate: boolean }
    > {
      public override compose () {
        const out: ReturnType<typeof h>[] = [h(Early, { n: this.props.n }, 'e')];
        if (this.props.showLate) {
          out.push(h(Late, {}, 'l'));
        }
        return out;
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
    expect(seen).toEqual(['n=1']);
    await rt.unmount();
  });

  it('parent onUpdate publish reaches same-pass PLACE child @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Child extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ n: number; show: boolean }, { n: number; show: boolean }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (): void {
        this.events.publish({ type: 'READY', payload: { id: `parent-${this.props.n}` } });
      }
      public override compose () {
        return this.props.show ? [h(Child, {}, 'c')] : [];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { n: 0, show: false }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { n: 1, show: true }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['parent-1']);
    await rt.unmount();
  });
});
