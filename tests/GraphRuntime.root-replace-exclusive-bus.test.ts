/**
 * Regression: root REPLACE wire-before-destroy (#157) materializes the
 * replacement while the victim still holds exclusive `@OnCommand` / `@OnQuery`
 * registrations → "already registered" → fail-stop.
 *
 * Pre-dispose the victim subtree (including nested handlers) before materialize.
 * EventBus onUnmount handoff must still reach the replacement `@OnEvent`.
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

describe('GraphRuntime root REPLACE exclusive bus pre-dispose', () => {
  it('root REPLACE same OnCommand does not fail-stop', async () => {
    class OldRoot extends Component {
      @OnCommand('DO')
      public handle (): void { /* old */ }
    }
    class NewRoot extends Component {
      @OnCommand('DO')
      public handle (): void { /* new */ }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(OldRoot, {}), undefined, b as any);
    await expect(rt.reconcile(h(NewRoot, {}))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });

  it('root REPLACE same OnQuery does not fail-stop', async () => {
    class OldRoot extends Component {
      @OnQuery('GET')
      public handle (): number { return 1; }
    }
    class NewRoot extends Component {
      @OnQuery('GET')
      public handle (): number { return 2; }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(OldRoot, {}), undefined, b as any);
    await expect(rt.reconcile(h(NewRoot, {}))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.queryBus.execute({ type: 'GET', payload: {} })).resolves.toBe(2);
    await rt.unmount();
  });

  it('nested child OnCommand under old root does not fail-stop', async () => {
    class Inner extends Component {
      @OnCommand('DO')
      public handle (): void { /* old nested */ }
    }
    class OldRoot extends Component {
      public override compose () {
        return [h(Inner, {}, 'i')];
      }
    }
    class NewRoot extends Component {
      @OnCommand('DO')
      public handle (): void { /* new */ }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(OldRoot, {}), undefined, b as any);
    await expect(rt.reconcile(h(NewRoot, {}))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });

  it('nested child OnQuery under old root does not fail-stop', async () => {
    class Inner extends Component {
      @OnQuery('GET')
      public handle (): number { return 1; }
    }
    class OldRoot extends Component {
      public override compose () {
        return [h(Inner, {}, 'i')];
      }
    }
    class NewRoot extends Component {
      @OnQuery('GET')
      public handle (): number { return 2; }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(OldRoot, {}), undefined, b as any);
    await expect(rt.reconcile(h(NewRoot, {}))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.queryBus.execute({ type: 'GET', payload: {} })).resolves.toBe(2);
    await rt.unmount();
  });

  it('old root onUnmount EventBus publish still reaches replacement @OnEvent', async () => {
    const seen: string[] = [];
    class OldRoot extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'old-root' } });
      }
    }
    class Listener extends Component {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(e.payload.id);
      }
    }
    class NewRoot extends Component {
      public override compose () {
        return [h(Listener, {}, 'l')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(OldRoot, {}), undefined, b as any);
    await rt.reconcile(h(NewRoot, {}));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['old-root']);
    await rt.unmount();
  });

  it('old nested onUnmount EventBus publish still reaches replacement @OnEvent', async () => {
    const seen: string[] = [];
    class Victim extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'victim' } });
      }
    }
    class OldRoot extends Component {
      public override compose () {
        return [h(Victim, {}, 'v')];
      }
    }
    class Listener extends Component {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(e.payload.id);
      }
    }
    class NewRoot extends Component {
      public override compose () {
        return [h(Listener, {}, 'l')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(OldRoot, {}), undefined, b as any);
    await rt.reconcile(h(NewRoot, {}));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['victim']);
    await rt.unmount();
  });
});
