/**
 * Regression: stable-path (`isStableChildren`) walks siblings left-to-right with full
 * nested reconcile — including PLACE — before the next sibling UPDATE. An Early UPDATE
 * can wire nested `@OnCommand`/`@OnQuery` while a Late sibling still holds the same
 * exclusive type on a nested child that this reconcile will drop → fail-stop.
 *
 * Distinct from #182 (full-diff deferred-UPDATE preview before PLACE peers): the
 * stable fast-path never enters that preview without this fix.
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

describe('GraphRuntime stable-path Early UPDATE nested PLACE vs Late exclusive', () => {
  it('Command: Early PLACE while Late still holds DO', async () => {
    class Handler extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* PLACE under Early */ }
    }
    class Inner extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* nested under Late */ }
    }
    class Early extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(Handler, {})] : [];
      }
    }
    class Late extends Component<{ drop: boolean }, { drop: boolean }> {
      public override compose () {
        return this.props.drop ? [] : [h(Inner, {})];
      }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(Early, { show: false }, 'e'), h(Late, { drop: false }, 'l')]
          : [h(Early, { show: true }, 'e'), h(Late, { drop: true }, 'l')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });

  it('Query: Early PLACE while Late still holds GET', async () => {
    class HandlerQ extends Component {
      @OnQuery('GET')
      public handle (): number { return 2; }
    }
    class InnerQ extends Component {
      @OnQuery('GET')
      public handle (): number { return 1; }
    }
    class EarlyQ extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(HandlerQ, {})] : [];
      }
    }
    class LateQ extends Component<{ drop: boolean }, { drop: boolean }> {
      public override compose () {
        return this.props.drop ? [] : [h(InnerQ, {})];
      }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(EarlyQ, { show: false }, 'e'), h(LateQ, { drop: false }, 'l')]
          : [h(EarlyQ, { show: true }, 'e'), h(LateQ, { drop: true }, 'l')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.queryBus.execute({ type: 'GET', payload: {} })).resolves.toBe(2);
    await rt.unmount();
  });

  it('unkeyed stable siblings: Early PLACE vs Late nested OnCommand', async () => {
    class Handler extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* PLACE */ }
    }
    class Inner extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* Late nested */ }
    }
    class Early extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(Handler, {})] : [];
      }
    }
    class Late extends Component<{ drop: boolean }, { drop: boolean }> {
      public override compose () {
        return this.props.drop ? [] : [h(Inner, {})];
      }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        // No keys → still stable (same type+position); must not skip preview.
        return this.props.phase === 1
          ? [h(Early, { show: false }), h(Late, { drop: false })]
          : [h(Early, { show: true }), h(Late, { drop: true })];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });
});
