/**
 * Regression: after nested REPLACE-victim teardown deferral (#195), parent full-diff
 * must destroy nested victims before flushing onUpdate.
 *
 * Holding victim destroy until the ancestor batch is correct for Late PLACE @OnEvent
 * handoff, but full-diff previously flushed onUpdate before victims — Early onUpdate
 * EventBus publishes dual-delivered to still-wired victim + replacement. Stable-path
 * flushSiblingBatchHooks already used victims → onUpdate → orphans.
 */
import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { UseEventBus, OnEvent } from '../src/runtime/BusDecorators';

type Ev = { type: 'PING'; payload: { id: string } };
type Empty = Record<string, never>;

function makeBuses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus(),
    queryBus: new QueryBus(),
  };
}

describe('GraphRuntime fulldiff deferred REPLACE victim before onUpdate', () => {
  it('fulldiff: Early onUpdate must not dual-deliver to REPLACE victim still wired', async () => {
    const seen: string[] = [];

    class Victim extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push('victim:' + e.payload.id);
      }
    }

    class Replacement extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push('replacement:' + e.payload.id);
      }
    }

    class Early extends Component<{ mode: 'a' | 'b' }, { mode: 'a' | 'b' }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (): void {
        this.events.publish({ type: 'PING', payload: { id: 'early-update' } });
      }
      public override compose () {
        return this.props.mode === 'a'
          ? [h(Victim, {}, 'v')]
          : [h(Replacement, {}, 'v')];
      }
    }

    class Extra extends Component<Empty, Empty> {}

    class Parent extends Component<{ mode: 'a' | 'b'; bump: boolean }, { mode: 'a' | 'b'; bump: boolean }> {
      public override compose () {
        // bump forces parent full-diff (extra sibling PLACE)
        return this.props.bump
          ? [h(Early, { mode: this.props.mode }, 'e'), h(Extra, {}, 'x')]
          : [h(Early, { mode: this.props.mode }, 'e')];
      }
    }

    const buses = makeBuses();
    const rt = await GraphRuntime.mount(
      h(Parent, { mode: 'a', bump: false }),
      undefined,
      buses as never,
    );
    await rt.reconcile(h(Parent, { mode: 'b', bump: true }));
    expect(seen).toEqual(['replacement:early-update']);
    await rt.unmount();
  });

  it('stable: Early onUpdate must not dual-deliver to REPLACE victim still wired', async () => {
    const seen: string[] = [];

    class Victim extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push('victim:' + e.payload.id);
      }
    }

    class Replacement extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push('replacement:' + e.payload.id);
      }
    }

    class Late extends Component<Empty, Empty> {}

    class Early extends Component<{ mode: 'a' | 'b' }, { mode: 'a' | 'b' }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (): void {
        this.events.publish({ type: 'PING', payload: { id: 'early-update' } });
      }
      public override compose () {
        return this.props.mode === 'a'
          ? [h(Victim, {}, 'v')]
          : [h(Replacement, {}, 'v')];
      }
    }

    class Parent extends Component<{ mode: 'a' | 'b' }, { mode: 'a' | 'b' }> {
      public override compose () {
        return [
          h(Early, { mode: this.props.mode }, 'e'),
          h(Late, {}, 'l'),
        ];
      }
    }

    const buses = makeBuses();
    const rt = await GraphRuntime.mount(
      h(Parent, { mode: 'a' }),
      undefined,
      buses as never,
    );
    await rt.reconcile(h(Parent, { mode: 'b' }));
    expect(seen).toEqual(['replacement:early-update']);
    await rt.unmount();
  });
});
