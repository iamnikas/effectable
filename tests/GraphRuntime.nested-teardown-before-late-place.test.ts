/**
 * Regression: nested REPLACE-victim / orphan onUnmount under Early UPDATE must reach
 * Late nested PLACE `@OnEvent` after the ancestor batch drains.
 *
 * #194 deferred nested onMount/onUpdate when the parent UPDATE is in a sibling batch,
 * but REPLACE-victim and orphan DELETE still ran inside Early's full-diff — before Late
 * nested PLACE wired listeners. Silent EventBus loss (stable + full-diff parent paths).
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

describe('GraphRuntime nested teardown before late nested PLACE', () => {
  it('stable: Early nested REPLACE victim onUnmount reaches Late nested @OnEvent', async () => {
    const seen: string[] = [];

    class Victim extends Component<Empty, Empty> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'PING', payload: { id: 'victim' } });
      }
    }

    class Replacement extends Component<Empty, Empty> {}

    class Early extends Component<{ mode: 'a' | 'b' }, { mode: 'a' | 'b' }> {
      public override compose () {
        return this.props.mode === 'a'
          ? [h(Victim, {}, 'v')]
          : [h(Replacement, {}, 'v')];
      }
    }

    class Listener extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Late extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(Listener, {})] : [];
      }
    }

    class Parent extends Component<{ mode: 'a' | 'b'; show: boolean }, { mode: 'a' | 'b'; show: boolean }> {
      public override compose () {
        return [
          h(Early, { mode: this.props.mode }, 'e'),
          h(Late, { show: this.props.show }, 'l'),
        ];
      }
    }

    const buses = makeBuses();
    const rt = await GraphRuntime.mount(
      h(Parent, { mode: 'a', show: false }),
      undefined,
      buses as never,
    );
    await rt.reconcile(h(Parent, { mode: 'b', show: true }));
    expect(seen).toEqual(['victim']);
    await rt.unmount();
  });

  it('fulldiff: Early nested REPLACE victim onUnmount reaches Late nested @OnEvent', async () => {
    const seen: string[] = [];

    class Victim extends Component<Empty, Empty> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'PING', payload: { id: 'fd' } });
      }
    }

    class Replacement extends Component<Empty, Empty> {}

    class Early extends Component<{ mode: 'a' | 'b' }, { mode: 'a' | 'b' }> {
      public override compose () {
        return this.props.mode === 'a'
          ? [h(Victim, {}, 'v')]
          : [h(Replacement, {}, 'v')];
      }
    }

    class Listener extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Late extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(Listener, {})] : [];
      }
    }

    class Extra extends Component<Empty, Empty> {}

    class Parent extends Component<{ mode: 'a' | 'b'; show: boolean }, { mode: 'a' | 'b'; show: boolean }> {
      public override compose () {
        return this.props.show
          ? [
              h(Early, { mode: this.props.mode }, 'e'),
              h(Late, { show: true }, 'l'),
              h(Extra, {}, 'x'),
            ]
          : [
              h(Early, { mode: this.props.mode }, 'e'),
              h(Late, { show: false }, 'l'),
            ];
      }
    }

    const buses = makeBuses();
    const rt = await GraphRuntime.mount(
      h(Parent, { mode: 'a', show: false }),
      undefined,
      buses as never,
    );
    await rt.reconcile(h(Parent, { mode: 'b', show: true }));
    expect(seen).toEqual(['fd']);
    await rt.unmount();
  });

  it('stable: Early nested orphan onUnmount reaches Late nested @OnEvent', async () => {
    const seen: string[] = [];

    class Leaving extends Component<Empty, Empty> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'PING', payload: { id: 'orphan' } });
      }
    }

    class Keeper extends Component<Empty, Empty> {}

    class Early extends Component<{ showLeave: boolean }, { showLeave: boolean }> {
      public override compose () {
        return this.props.showLeave
          ? [h(Keeper, {}, 'k'), h(Leaving, {}, 'x')]
          : [h(Keeper, {}, 'k')];
      }
    }

    class Listener extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Late extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(Listener, {})] : [];
      }
    }

    class Parent extends Component<
      { showLeave: boolean; show: boolean },
      { showLeave: boolean; show: boolean }
    > {
      public override compose () {
        return [
          h(Early, { showLeave: this.props.showLeave }, 'e'),
          h(Late, { show: this.props.show }, 'l'),
        ];
      }
    }

    const buses = makeBuses();
    const rt = await GraphRuntime.mount(
      h(Parent, { showLeave: true, show: false }),
      undefined,
      buses as never,
    );
    await rt.reconcile(h(Parent, { showLeave: false, show: true }));
    expect(seen).toEqual(['orphan']);
    await rt.unmount();
  });
});
