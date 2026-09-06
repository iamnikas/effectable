/**
 * Regression: isStableChildren fast-path walks siblings left-to-right; each UPDATE
 * fully reconciles nested children (including PLACE) before the next sibling UPDATE.
 * Unlike full-diff (#182), there is no pre-walk exclusive release — Early nested PLACE
 * `@OnCommand`/`@OnQuery` can clash with Late's still-held nested exclusive → fail-stop.
 *
 * Distinct from #182 (full-diff deferred UPDATE preview before sibling PLACE).
 */
import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { OnCommand, OnQuery } from '../src/runtime/BusDecorators';

type Cmd = { type: 'DO'; payload: { id: string } };
type Q = { type: 'GET'; payload: Record<string, never> };
type Ev = { type: 'READY'; payload: { id: string } };
type Empty = Record<string, never>;

function buses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus<Cmd>(),
    queryBus: new QueryBus<Q>(),
  };
}

describe('GraphRuntime stable-path Early nested PLACE vs Late exclusive', () => {
  it('Early PLACE OnCommand after Late drops nested holder (unkeyed stable)', async () => {
    class Handler extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* Early PLACE */ }
    }
    class Early extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(Handler)] : [];
      }
    }
    class Inner extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* Late holder */ }
    }
    class Late extends Component<{ drop: boolean }, { drop: boolean }> {
      public override compose () {
        return this.props.drop ? [] : [h(Inner)];
      }
    }
    class Parent extends Component<
      { earlyShow: boolean; lateDrop: boolean },
      { earlyShow: boolean; lateDrop: boolean }
    > {
      public override compose () {
        // Same length + type + (no)key → isStableChildren fast-path
        return [
          h(Early, { show: this.props.earlyShow }),
          h(Late, { drop: this.props.lateDrop }),
        ];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(
      h(Parent, { earlyShow: false, lateDrop: false }),
      undefined,
      b as any,
    );
    await expect(
      rt.reconcile(h(Parent, { earlyShow: true, lateDrop: true })),
    ).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });

  it('Early PLACE OnQuery after Late drops nested holder (keyed stable)', async () => {
    class HandlerQ extends Component<Empty, Empty> {
      @OnQuery('GET')
      public handle (): number { return 2; }
    }
    class EarlyQ extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(HandlerQ)] : [];
      }
    }
    class InnerQ extends Component<Empty, Empty> {
      @OnQuery('GET')
      public handle (): number { return 1; }
    }
    class LateQ extends Component<{ drop: boolean }, { drop: boolean }> {
      public override compose () {
        return this.props.drop ? [] : [h(InnerQ)];
      }
    }
    class Parent extends Component<
      { earlyShow: boolean; lateDrop: boolean },
      { earlyShow: boolean; lateDrop: boolean }
    > {
      public override compose () {
        return [
          h(EarlyQ, { show: this.props.earlyShow }, 'e'),
          h(LateQ, { drop: this.props.lateDrop }, 'l'),
        ];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(
      h(Parent, { earlyShow: false, lateDrop: false }),
      undefined,
      b as any,
    );
    await expect(
      rt.reconcile(h(Parent, { earlyShow: true, lateDrop: true })),
    ).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.queryBus.execute({ type: 'GET', payload: {} })).resolves.toBe(2);
    await rt.unmount();
  });

  it('Early PLACE after Late REPLACE frees nested OnCommand (stable)', async () => {
    class Handler extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* Early PLACE */ }
    }
    class Early extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(Handler)] : [];
      }
    }
    class OldInner extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* REPLACE victim */ }
    }
    class NewInner extends Component<Empty, Empty> {
      /* no exclusive */
    }
    class Late extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(OldInner, undefined, 'slot')]
          : [h(NewInner, undefined, 'slot')];
      }
    }
    class Parent extends Component<
      { earlyShow: boolean; latePhase: 1 | 2 },
      { earlyShow: boolean; latePhase: 1 | 2 }
    > {
      public override compose () {
        return [
          h(Early, { show: this.props.earlyShow }, 'e'),
          h(Late, { phase: this.props.latePhase }, 'l'),
        ];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(
      h(Parent, { earlyShow: false, latePhase: 1 }),
      undefined,
      b as any,
    );
    await expect(
      rt.reconcile(h(Parent, { earlyShow: true, latePhase: 2 })),
    ).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });
});
