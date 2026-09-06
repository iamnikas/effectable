/**
 * Regression: after #195 deferred nested orphan teardown under Early UPDATE,
 * ancestor batch must destroy those orphans *before* flushing onUpdate.
 *
 * Holding orphan destroy until the ancestor batch is correct for Late PLACE
 * @OnEvent handoff from onUnmount, but flushing onUpdate first dual-delivers
 * Early's EventBus publish to the still-wired nested orphan and Late's PLACE
 * listener. Sibling-level orphans (pendingOrphanSet) still destroy after
 * onUpdate for intentional UPDATE↔DELETE handoff.
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

describe('GraphRuntime deferred nested orphan before onUpdate', () => {
  it('stable: Early onUpdate must not dual-deliver to nested orphan still wired', async () => {
    const seen: string[] = [];

    class Orphan extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push('orphan:' + e.payload.id);
      }
    }

    class LateListener extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push('late:' + e.payload.id);
      }
    }

    class Early extends Component<{ show: boolean }, { show: boolean }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (): void {
        this.events.publish({ type: 'PING', payload: { id: 'early-update' } });
      }
      public override compose () {
        return this.props.show ? [h(Orphan, {}, 'o')] : [];
      }
    }

    class Late extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(LateListener, {})] : [];
      }
    }

    class Parent extends Component<{ early: boolean; late: boolean }, { early: boolean; late: boolean }> {
      public override compose () {
        return [
          h(Early, { show: this.props.early }, 'e'),
          h(Late, { show: this.props.late }, 'l'),
        ];
      }
    }

    const buses = makeBuses();
    const rt = await GraphRuntime.mount(
      h(Parent, { early: true, late: false }),
      undefined,
      buses as never,
    );
    await rt.reconcile(h(Parent, { early: false, late: true }));
    expect(seen).toEqual(['late:early-update']);
    await rt.unmount();
  });

  it('fulldiff: Early onUpdate must not dual-deliver to nested orphan still wired', async () => {
    const seen: string[] = [];

    class Orphan extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push('orphan:' + e.payload.id);
      }
    }

    class LateListener extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push('late:' + e.payload.id);
      }
    }

    class Extra extends Component<Empty, Empty> {}

    class Early extends Component<{ show: boolean }, { show: boolean }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (): void {
        this.events.publish({ type: 'PING', payload: { id: 'fd-early' } });
      }
      public override compose () {
        return this.props.show ? [h(Orphan, {}, 'o')] : [];
      }
    }

    class Late extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(LateListener, {})] : [];
      }
    }

    class Parent extends Component<
      { early: boolean; late: boolean; bump: boolean },
      { early: boolean; late: boolean; bump: boolean }
    > {
      public override compose () {
        return this.props.bump
          ? [
              h(Early, { show: this.props.early }, 'e'),
              h(Late, { show: this.props.late }, 'l'),
              h(Extra, {}, 'x'),
            ]
          : [
              h(Early, { show: this.props.early }, 'e'),
              h(Late, { show: this.props.late }, 'l'),
            ];
      }
    }

    const buses = makeBuses();
    const rt = await GraphRuntime.mount(
      h(Parent, { early: true, late: false, bump: false }),
      undefined,
      buses as never,
    );
    await rt.reconcile(h(Parent, { early: false, late: true, bump: true }));
    expect(seen).toEqual(['late:fd-early']);
    await rt.unmount();
  });

  it('sibling orphan handoff: Early onUpdate still reaches sibling DELETE @OnEvent', async () => {
    const seen: string[] = [];

    class Orphan extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push('orphan:' + e.payload.id);
      }
    }

    class Early extends Component<{ n: number }, { n: number }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (): void {
        this.events.publish({ type: 'PING', payload: { id: 'sib' } });
      }
      public override compose () {
        return [];
      }
    }

    class Parent extends Component<{ keep: boolean; n: number }, { keep: boolean; n: number }> {
      public override compose () {
        return this.props.keep
          ? [h(Early, { n: this.props.n }, 'e'), h(Orphan, {}, 'o')]
          : [h(Early, { n: this.props.n }, 'e')];
      }
    }

    const buses = makeBuses();
    const rt = await GraphRuntime.mount(
      h(Parent, { keep: true, n: 1 }),
      undefined,
      buses as never,
    );
    await rt.reconcile(h(Parent, { keep: false, n: 2 }));
    expect(seen).toEqual(['orphan:sib']);
    await rt.unmount();
  });
});
