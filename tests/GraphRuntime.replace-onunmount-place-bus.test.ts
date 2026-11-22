/**
 * Regression probe: REPLACE victim onUnmount before later PLACE bus wire.
 *
 * In one reconcile batch, destroyFiber(REPLACE victim) runs onUnmount (and any
 * bus publish) before a later sibling PLACE finishes @On* wiring — silent drop.
 * Distinct from #108 (deferred REPLACE/PLACE onMount) and #119/#126 (UPDATE onUpdate).
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

describe('GraphRuntime REPLACE onUnmount before PLACE bus wire', () => {
  it('PLACE listener receives REPLACE victim onUnmount publish in same batch', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Victim extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'victim' } });
      }
    }

    class Replacement extends Component {}

    class Listener extends Component {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ mode: 'init' | 'swap' }, { mode: 'init' | 'swap' }> {
      public override compose () {
        if (this.props.mode === 'init') {
          // Only the victim — listener arrives in the same batch as REPLACE.
          return [h(Victim, {}, 'a')];
        }
        // Key 'a' REPLACE Victim→Replacement; key 'b' PLACE Listener.
        // Today: Victim.onUnmount publishes before Listener buses wire → seen=[].
        return [h(Replacement, {}, 'a'), h(Listener, {}, 'b')];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { mode: 'init' }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { mode: 'swap' }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['victim']);
    await rt.unmount();
  });

  it('keyed REPLACE then REPLACE listener: new listener hears prior victim onUnmount', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Victim extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'victim' } });
      }
    }

    class OldListener extends Component {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(`old:${e.payload.id}`);
      }
    }

    class Replacement extends Component {}

    class NewListener extends Component {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(`new:${e.payload.id}`);
      }
    }

    class Parent extends Component<{ mode: 'init' | 'swap' }, { mode: 'init' | 'swap' }> {
      public override compose () {
        if (this.props.mode === 'init') {
          return [h(Victim, {}, 'a'), h(OldListener, {}, 'b')];
        }
        // Both slots REPLACE: destroy a then PLACE/REPLACE wire for a', destroy b, wire b'.
        // Victim.onUnmount runs before NewListener buses exist.
        return [h(Replacement, {}, 'a'), h(NewListener, {}, 'b')];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { mode: 'init' }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { mode: 'swap' }));
    expect(rt.isActive()).toBe(true);
    // OldListener is still alive when Victim destroys (compose-order destroy of a
    // before b), so old hears it. NewListener must also hear once buses wire first.
    expect(seen).toContain('new:victim');
    await rt.unmount();
  });
});
