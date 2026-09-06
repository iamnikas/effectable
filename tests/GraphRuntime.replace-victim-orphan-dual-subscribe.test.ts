/**
 * #122 residual: deferred REPLACE victims stay bus-wired until flushPendingReplaceVictims,
 * but fullDiff destroys keyed/unkeyed orphans *before* that flush. An orphan onUnmount
 * publish is then delivered to BOTH the still-wired victim and the already-wired
 * replacement (double handling). develop (eager REPLACE destroy) only delivered to the
 * replacement. Fix: destroy pending REPLACE victims before orphan teardown.
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

describe('GraphRuntime REPLACE victim vs orphan DELETE dual-subscribe', () => {
  it('orphan onUnmount reaches only the replacement, not the deferred REPLACE victim', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Victim extends Component {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(`victim:${e.payload.id}`);
      }
    }

    class Replacement extends Component {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(`new:${e.payload.id}`);
      }
    }

    class Orphan extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'orphan' } });
      }
    }

    class Parent extends Component<{ mode: 'init' | 'swap' }, { mode: 'init' | 'swap' }> {
      public override compose () {
        if (this.props.mode === 'init') {
          return [h(Victim, {}, 'a'), h(Orphan, {}, 'orphan')];
        }
        // key a REPLACE Victim→Replacement; key orphan DELETE
        return [h(Replacement, {}, 'a')];
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
    // develop / intended: only replacement hears orphan bye
    expect(seen).toEqual(['new:orphan']);
    await rt.unmount();
  });
});
