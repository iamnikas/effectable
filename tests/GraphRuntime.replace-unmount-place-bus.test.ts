/**
 * Regression: REPLACE victim onUnmount used to run before later PLACE siblings
 * wired @On* handlers, so teardown publishes were silently dropped. #108 deferred
 * replacement onMount only — not victim teardown.
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

describe('GraphRuntime REPLACE onUnmount vs PLACE sibling bus', () => {
  it('PLACE listener receives REPLACE victim onUnmount publish', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class VictimA extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'victim-a' } });
      }
    }

    class ReplacementA extends Component {}

    class Listener extends Component {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ mode: 'init' | 'swap' }, { mode: 'init' | 'swap' }> {
      public override compose () {
        if (this.props.mode === 'init') {
          // key a = VictimA; no listener yet
          return [h(VictimA, {}, 'a')];
        }
        // key a REPLACE VictimA→ReplacementA (onUnmount publishes);
        // key b PLACE Listener.
        return [h(ReplacementA, {}, 'a'), h(Listener, {}, 'b')];
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
    expect(seen).toEqual(['victim-a']);
    await rt.unmount();
  });
});
