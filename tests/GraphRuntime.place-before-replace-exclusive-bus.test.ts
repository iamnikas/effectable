/**
 * Regression: in one full-diff batch, a PLACE sibling can run *before* a later
 * same-key REPLACE destroys its victim. Exclusive `@OnCommand` / `@OnQuery` on the
 * victim (or nested under it) were still registered → "already registered" → fail-stop.
 *
 * Distinct from REMOVE+PLACE orphans (#164/#170) and root REPLACE wire-before-destroy (#173).
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
type Empty = Record<string, never>;

function buses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus<Cmd>(),
    queryBus: new QueryBus<Q>(),
  };
}

describe('GraphRuntime PLACE-before-REPLACE exclusive bus', () => {
  it('PLACE before same-key REPLACE OnCommand does not fail-stop', async () => {
    class OldHandler extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* old — holds exclusive until REPLACE */ }
    }
    class Early extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* PLACE claims DO before REPLACE runs */ }
    }
    class NewShell extends Component<Empty, Empty> {
      /* replacement must not also claim DO — that would be dual live handlers */
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(OldHandler, {}, 'slot')]
          : [h(Early, {}, 'early'), h(NewShell, {}, 'slot')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });

  it('PLACE before same-key REPLACE OnQuery does not fail-stop', async () => {
    class OldQ extends Component<Empty, Empty> {
      @OnQuery('GET')
      public handle (): number { return 1; }
    }
    class EarlyQ extends Component<Empty, Empty> {
      @OnQuery('GET')
      public handle (): number { return 3; }
    }
    class NewShell extends Component<Empty, Empty> {}
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(OldQ, {}, 'slot')]
          : [h(EarlyQ, {}, 'early'), h(NewShell, {}, 'slot')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.queryBus.execute({ type: 'GET', payload: {} })).resolves.toBe(3);
    await rt.unmount();
  });

  it('PLACE before REPLACE nested OnCommand under victim does not fail-stop', async () => {
    class Inner extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* nested exclusive under REPLACE wrapper */ }
    }
    class Wrapper extends Component<Empty, Empty> {
      public override compose () {
        return [h(Inner, {})];
      }
    }
    class Early extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* */ }
    }
    class NewWrapper extends Component<Empty, Empty> {
      public override compose () {
        return [];
      }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(Wrapper, {}, 'slot')]
          : [h(Early, {}, 'early'), h(NewWrapper, {}, 'slot')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });

  it('REPLACE victim EventBus onUnmount still reaches earlier PLACE @OnEvent', async () => {
    const seen: string[] = [];
    class Victim extends Component<Empty, Empty> {
      @UseEventBus() declare events: EventBus<Ev>;
      @OnCommand('DO')
      public handle (): void { /* exclusive also present */ }
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'victim' } });
      }
    }
    class Listener extends Component<Empty, Empty> {
      @OnEvent('BYE')
      public onBye (e: Ev): void { seen.push(e.payload.id); }
    }
    class NewShell extends Component<Empty, Empty> {}
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(Victim, {}, 'slot')]
          : [h(Listener, {}, 'listener'), h(NewShell, {}, 'slot')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await rt.reconcile(h(Parent, { phase: 2 }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['victim']);
    await rt.unmount();
  });
});
