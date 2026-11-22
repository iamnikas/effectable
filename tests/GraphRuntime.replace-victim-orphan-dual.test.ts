/**
 * Residual on deferred REPLACE victim (#139 / #122): orphan DELETE onUnmount must
 * not dual-deliver to both still-wired victim and replacement.
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

describe('GraphRuntime REPLACE victim + orphan DELETE dual-subscribe', () => {
  it('orphan onUnmount must not hit both REPLACE victim and replacement', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class VictimListener extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(`victim:${e.payload.id}`);
      }
    }

    class ReplacementListener extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(`new:${e.payload.id}`);
      }
    }

    class Leaving extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'READY', payload: { id: 'orphan' } });
      }
    }

    class Parent extends Component<{ mode: 'a' | 'b' }, { mode: 'a' | 'b' }> {
      public override compose () {
        if (this.props.mode === 'a') {
          return [h(VictimListener, {}, 'a'), h(Leaving, {}, 'b')];
        }
        // key a REPLACE Victim→Replacement; key b DELETE Leaving
        return [h(ReplacementListener, {}, 'a')];
      }
    }

    const rt = await GraphRuntime.mount(h(Parent, { mode: 'a' }), undefined, buses as any);
    await rt.reconcile(h(Parent, { mode: 'b' }));
    expect(rt.isActive()).toBe(true);
    // Victim must already be destroyed before orphan onUnmount; only replacement hears it.
    expect(seen).toEqual(['new:orphan']);
    await rt.unmount();
  });
});
