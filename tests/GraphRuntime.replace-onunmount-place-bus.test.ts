/**
 * Regression: REPLACE destroyed the victim (and ran `onUnmount`) before a later
 * PLACE sibling finished `@On*` bus wiring, so teardown publishes in the same
 * reconcile batch were silently dropped.
 *
 * Complements #108 (deferred REPLACE/PLACE onMount) and #119 (deferred UPDATE
 * onUpdate): those still destroy REPLACE victims immediately during the
 * left-to-right structure pass.
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

describe('GraphRuntime REPLACE onUnmount before PLACE bus', () => {
  it('REPLACE onUnmount publish reaches same-batch PLACE @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Victim extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'victim' } });
      }
    }

    class Listener extends Component {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Other extends Component {}

    class Parent extends Component<{ mode: 'a' | 'b' }, { mode: 'a' | 'b' }> {
      public override compose () {
        if (this.props.mode === 'a') {
          return [h(Victim, {}, 'x')];
        }
        // key x REPLACE Victim→Other; key y PLACE Listener.
        return [h(Other, {}, 'x'), h(Listener, {}, 'y')];
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
    expect(seen).toEqual(['victim']);
    await rt.unmount();
  });

  it('control: PLACE listener already mounted still receives REPLACE onUnmount', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Victim extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'victim' } });
      }
    }

    class Listener extends Component {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Other extends Component {}

    class Parent extends Component<{ mode: 'a' | 'b' }, { mode: 'a' | 'b' }> {
      public override compose () {
        if (this.props.mode === 'a') {
          return [h(Victim, {}, 'x'), h(Listener, {}, 'y')];
        }
        return [h(Other, {}, 'x'), h(Listener, {}, 'y')];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { mode: 'a' }),
      undefined,
      buses as any,
    );
    seen.length = 0;
    await rt.reconcile(h(Parent, { mode: 'b' }));
    expect(seen).toEqual(['victim']);
    await rt.unmount();
  });
});
