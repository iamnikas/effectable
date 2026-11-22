/**
 * Regression: parent UPDATE `onUpdate` publish must reach a newly composed own
 * PLACE child's `@OnEvent` handlers.
 *
 * Distinct from sibling UPDATE→PLACE deferral (#125) and full-diff pass-2 nested
 * PLACE under a later UPDATE sibling (#186). Here the listener is a new child of
 * the SAME fiber whose onUpdate is firing. updateFiber used to call onUpdate
 * before reconcileChildren, so the publish was silently dropped.
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

describe('GraphRuntime parent onUpdate vs own child PLACE', () => {
  it('CONTROL: publish after child PLACE reaches @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Listener extends Component {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ n: number; show: boolean }, { n: number; show: boolean }> {
      @UseEventBus() declare events: EventBus<Ev>;

      public override compose () {
        if (!this.props.show) {
          return [];
        }
        return [h(Listener, {})];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { n: 1, show: false }),
      undefined,
      buses as any,
    );

    await rt.reconcile(h(Parent, { n: 2, show: true }));
    const root = rt.getRootInstance() as Parent;
    root.events.publish({ type: 'PING', payload: { id: 'after' } });
    expect(seen).toEqual(['after']);
    await rt.unmount();
  });

  it('onUpdate publish during UPDATE reaches own newly PLACEd @OnEvent child', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Listener extends Component {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ n: number; show: boolean }, { n: number; show: boolean }> {
      @UseEventBus() declare events: EventBus<Ev>;

      public override onUpdate (prev: { n: number; show: boolean }): void {
        if (!prev.show && this.props.show) {
          this.events.publish({ type: 'PING', payload: { id: `n=${this.props.n}` } });
        }
      }

      public override compose () {
        if (!this.props.show) {
          return [];
        }
        return [h(Listener, {})];
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

  it('keyed: onUpdate publish reaches own newly PLACEd @OnEvent child', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Listener extends Component {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ n: number; show: boolean }, { n: number; show: boolean }> {
      @UseEventBus() declare events: EventBus<Ev>;

      public override onUpdate (prev: { n: number; show: boolean }): void {
        if (!prev.show && this.props.show) {
          this.events.publish({ type: 'PING', payload: { id: `keyed-${this.props.n}` } });
        }
      }

      public override compose () {
        if (!this.props.show) {
          return [];
        }
        return [h(Listener, {}, 'listener')];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { n: 1, show: false }, 'root'),
      undefined,
      buses as any,
    );

    await rt.reconcile(h(Parent, { n: 3, show: true }, 'root'));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['keyed-3']);
    await rt.unmount();
  });
});
