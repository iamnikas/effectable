/**
 * Regression: root REPLACE destroyed the victim (onUnmount + bus publish) before the
 * replacement tree finished @On* wiring — silent event loss on shared runtime buses.
 *
 * Sibling REPLACE deferral (#133/#136/#139) only covers deferLifecycle=true child batches;
 * root reconcile keeps deferLifecycle=false and must still wire-before-destroy locally.
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

describe('GraphRuntime root REPLACE onUnmount vs replacement @OnEvent', () => {
  it('old root onUnmount publish reaches new tree @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

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

    const rt = await GraphRuntime.mount(h(OldRoot, {}), undefined, buses as any);
    expect(seen).toEqual([]);

    await rt.reconcile(h(NewRoot, {}));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['old-root']);
    await rt.unmount();
  });

  it('old child onUnmount publish reaches listener under replacement root', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

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

    const rt = await GraphRuntime.mount(h(OldRoot, {}), undefined, buses as any);
    await rt.reconcile(h(NewRoot, {}));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['victim']);
    await rt.unmount();
  });

  it('replacement onMount still runs after root REPLACE handoff', async () => {
    const log: string[] = [];
    const buses = makeBuses();

    class OldRoot extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'bye' } });
        log.push('old-unmount');
      }
    }

    class Listener extends Component {
      @OnEvent('BYE')
      public onBye (): void {
        log.push('heard-bye');
      }

      public override onMount (): void {
        log.push('listener-mount');
      }
    }

    class NewRoot extends Component {
      public override onMount (): void {
        log.push('new-root-mount');
      }

      public override compose () {
        return [h(Listener, {}, 'l')];
      }
    }

    const rt = await GraphRuntime.mount(h(OldRoot, {}), undefined, buses as any);
    await rt.reconcile(h(NewRoot, {}));
    expect(rt.isActive()).toBe(true);
    // Sync publish delivers before onUnmount continues; then deferred onMount flush
    // (children before parent).
    expect(log).toEqual(['heard-bye', 'old-unmount', 'listener-mount', 'new-root-mount']);
    await rt.unmount();
  });
});
