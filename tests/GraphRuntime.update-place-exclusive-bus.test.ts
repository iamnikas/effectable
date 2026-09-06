/**
 * Regression: full-diff defers same-type UPDATE until after PLACE so onUpdate can
 * reach new `@On*` peers. That left nested `@OnCommand` / `@OnQuery` under a
 * *surviving* UPDATE wrapper registered while a same-batch PLACE sibling tried to
 * claim the exclusive type → fail-stop ("already registered").
 *
 * Distinct from REMOVE+PLACE orphan pre-release (#170): the keeper is not an orphan.
 */
import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { OnCommand, OnQuery, OnEvent, UseEventBus } from '../src/runtime/BusDecorators';

type Cmd = { type: 'DO'; payload: { id: string } };
type Q = { type: 'GET'; payload: Record<string, never> };
type Ev = { type: 'READY'; payload: { id: string } };

function buses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus<Cmd>(),
    queryBus: new QueryBus<Q>(),
  };
}

describe('GraphRuntime UPDATE-held exclusive vs same-batch PLACE', () => {
  it('keyed UPDATE dropping nested OnCommand frees slot for PLACE sibling', async () => {
    class Inner extends Component {
      @OnCommand('DO')
      public handle (): void { /* nested under surviving keeper */ }
    }
    class Keeper extends Component<{ hasInner: boolean }, { hasInner: boolean }> {
      public override compose () {
        return this.props.hasInner ? [h(Inner, {})] : [];
      }
    }
    class NewHandler extends Component {
      @OnCommand('DO')
      public handle (): void { /* PLACE sibling */ }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(Keeper, { hasInner: true }, 'k')]
          : [
              h(Keeper, { hasInner: false }, 'k'),
              h(NewHandler, {}, 'n'),
            ];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });

  it('keyed UPDATE dropping nested OnQuery frees slot for PLACE sibling', async () => {
    class InnerQ extends Component {
      @OnQuery('GET')
      public handle (): number { return 1; }
    }
    class KeeperQ extends Component<{ hasInner: boolean }, { hasInner: boolean }> {
      public override compose () {
        return this.props.hasInner ? [h(InnerQ, {})] : [];
      }
    }
    class NewQ extends Component {
      @OnQuery('GET')
      public handle (): number { return 2; }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(KeeperQ, { hasInner: true }, 'k')]
          : [
              h(KeeperQ, { hasInner: false }, 'k'),
              h(NewQ, {}, 'n'),
            ];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.queryBus.execute({ type: 'GET', payload: {} })).resolves.toBe(2);
    await rt.unmount();
  });

  it('deep nested OnCommand under mid-level UPDATE frees slot for PLACE', async () => {
    class Leaf extends Component {
      @OnCommand('DO')
      public handle (): void { /* deep */ }
    }
    class Mid extends Component<{ hasLeaf: boolean }, { hasLeaf: boolean }> {
      public override compose () {
        return this.props.hasLeaf ? [h(Leaf, {})] : [];
      }
    }
    class Keeper extends Component<{ hasLeaf: boolean }, { hasLeaf: boolean }> {
      public override compose () {
        return [h(Mid, { hasLeaf: this.props.hasLeaf }, 'm')];
      }
    }
    class NewHandler extends Component {
      @OnCommand('DO')
      public handle (): void { /* PLACE */ }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(Keeper, { hasLeaf: true }, 'k')]
          : [
              h(Keeper, { hasLeaf: false }, 'k'),
              h(NewHandler, {}, 'n'),
            ];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });

  it('REPLACE under surviving UPDATE frees nested OnCommand for PLACE sibling', async () => {
    class OldInner extends Component {
      @OnCommand('DO')
      public handle (): void { /* replace victim */ }
    }
    class NewInner extends Component {
      /* no exclusive handler */
    }
    class Keeper extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(OldInner, {}, 'slot')]
          : [h(NewInner, {}, 'slot')];
      }
    }
    class NewHandler extends Component {
      @OnCommand('DO')
      public handle (): void { /* PLACE sibling */ }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(Keeper, { phase: 1 }, 'k')]
          : [
              h(Keeper, { phase: 2 }, 'k'),
              h(NewHandler, {}, 'n'),
            ];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });

  it('UPDATE onUpdate EventBus publish still reaches same-batch PLACE @OnEvent', async () => {
    const seen: string[] = [];
    class Publisher extends Component<{ n: number }, { n: number }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (prev: { n: number }): void {
        if (prev.n !== this.props.n) {
          this.events.publish({ type: 'READY', payload: { id: `n=${this.props.n}` } });
        }
      }
    }
    class Listener extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(e.payload.id);
      }
    }
    class Parent extends Component<{ n: number; show: boolean }, { n: number; show: boolean }> {
      public override compose () {
        if (!this.props.show) {
          return [h(Publisher, { n: this.props.n }, 'p')];
        }
        return [
          h(Publisher, { n: this.props.n }, 'p'),
          h(Listener, {}, 'l'),
        ];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { n: 1, show: false }), undefined, b as any);
    await rt.reconcile(h(Parent, { n: 2, show: true }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['n=2']);
    await rt.unmount();
  });
});
