/**
 * Regression: keyed REMOVE+PLACE in one reconcile used to PLACE-wire `@OnCommand` /
 * `@OnQuery` while the orphan still held that exclusive registration →
 * "already registered" → fail-stop.
 *
 * Same-key REPLACE destroys before PLACE (safe). Different-key REMOVE+PLACE must
 * unregister the orphan's exclusive buses before the new sibling registers.
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
type Ev = { type: 'BYE'; payload: { id: string } };

function buses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus<Cmd>(),
    queryBus: new QueryBus<Q>(),
  };
}

describe('GraphRuntime REMOVE+PLACE exclusive bus handoff', () => {
  it('keyed REMOVE+PLACE same OnCommand does not fail-stop', async () => {
    class OldHandler extends Component {
      @OnCommand('DO')
      public handle (): void { /* old */ }
    }
    class NewHandler extends Component {
      @OnCommand('DO')
      public handle (): void { /* new */ }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(OldHandler, {}, 'old')]
          : [h(NewHandler, {}, 'new')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });

  it('keyed REMOVE+PLACE same OnQuery does not fail-stop', async () => {
    class OldQ extends Component {
      @OnQuery('GET')
      public handle (): number { return 1; }
    }
    class NewQ extends Component {
      @OnQuery('GET')
      public handle (): number { return 2; }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(OldQ, {}, 'a')]
          : [h(NewQ, {}, 'b')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.queryBus.execute({ type: 'GET', payload: {} })).resolves.toBe(2);
    await rt.unmount();
  });

  it('orphan onUnmount EventBus publish still reaches PLACE @OnEvent', async () => {
    const seen: string[] = [];
    class Victim extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'orphan' } });
      }
    }
    class Late extends Component {
      @OnEvent('BYE')
      public onBye (e: Ev): void { seen.push(e.payload.id); }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(Victim, {}, 'v')]
          : [h(Late, {}, 'l')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await rt.reconcile(h(Parent, { phase: 2 }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['orphan']);
    await rt.unmount();
  });

  it('same-key REPLACE OnCommand still works (destroy-before-PLACE)', async () => {
    class OldHandler extends Component {
      @OnCommand('DO')
      public handle (): void { /* old */ }
    }
    class NewHandler extends Component {
      @OnCommand('DO')
      public handle (): void { /* new */ }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(OldHandler, {}, 'slot')]
          : [h(NewHandler, {}, 'slot')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await rt.unmount();
  });
});
