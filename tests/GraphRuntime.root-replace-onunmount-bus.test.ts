/**
 * Regression: root REPLACE destroyed the old root (onUnmount) before the
 * replacement tree finished @On* bus wiring — teardown publishes were silently
 * dropped.
 *
 * Sibling REPLACE+PLACE onUnmount ordering is covered by open PRs (#133/#136/#139);
 * those keep deferLifecycle=false on the root path, so this case stays distinct.
 */

import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { UseEventBus, OnEvent } from '../src/runtime/BusDecorators';

type Ev = { type: 'BYE'; payload: { id: string } };
type EmptyProps = Record<string, never>;

function makeBuses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus(),
    queryBus: new QueryBus(),
  };
}

describe('GraphRuntime root REPLACE onUnmount vs new tree @On*', () => {
  it('OldRoot.onUnmount publish reaches NewRoot child @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class OldRoot extends Component<Record<string, never>, EmptyProps> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'old-root' } });
      }
    }

    class Listener extends Component<Record<string, never>, EmptyProps> {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class NewRoot extends Component<Record<string, never>, EmptyProps> {
      public override compose () {
        return [h(Listener, {})];
      }
    }

    const rt = await GraphRuntime.mount(h(OldRoot, {}), undefined, buses as any);
    await rt.reconcile(h(NewRoot, {}));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['old-root']);
    await rt.unmount();
  });

  it('root REPLACE still mounts NewRoot after OldRoot onUnmount', async () => {
    const order: string[] = [];
    const buses = makeBuses();

    class OldRoot extends Component<Record<string, never>, EmptyProps> {
      public override onUnmount (): void {
        order.push('old-unmount');
      }
    }

    class NewRoot extends Component<Record<string, never>, EmptyProps> {
      public override onMount (): void {
        order.push('new-mount');
      }
    }

    const rt = await GraphRuntime.mount(h(OldRoot, {}), undefined, buses as any);
    await rt.reconcile(h(NewRoot, {}));
    expect(rt.isActive()).toBe(true);
    expect(rt.getRootInstance()).toBeInstanceOf(NewRoot);
    expect(order).toEqual(['old-unmount', 'new-mount']);
    await rt.unmount();
  });
});
