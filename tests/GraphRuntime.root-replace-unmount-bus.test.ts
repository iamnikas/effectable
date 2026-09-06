/**
 * Regression: root REPLACE destroyed the old root (onUnmount) before the
 * replacement finished @On* bus wiring — teardown publishes were silently
 * dropped. Sibling REPLACE PRs only cover `deferLifecycle=true` child batches;
 * root reconcile leaves deferLifecycle false and must wire→destroy→flush itself.
 *
 * Distinct from #108 (REPLACE/PLACE onMount defer) and sibling onUnmount→PLACE filings.
 */

import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { UseEventBus, OnEvent } from '../src/runtime/BusDecorators';

type Ev = { type: 'BYE'; payload: { id: string } };
type Empty = Record<string, never>;

function makeBuses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus(),
    queryBus: new QueryBus(),
  };
}

describe('GraphRuntime root REPLACE onUnmount bus handoff', () => {
  it('OldRoot.onUnmount publish reaches NewRoot @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class OldRoot extends Component<Empty, Empty> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'old-root-unmount' } });
      }
    }

    class NewRoot extends Component<Empty, Empty> {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    const rt = await GraphRuntime.mount(h(OldRoot, {}), undefined, buses as any);
    expect(seen).toEqual([]);

    await rt.reconcile(h(NewRoot, {}));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['old-root-unmount']);
    await rt.unmount();
  });

  it('OldRoot child onUnmount publish reaches NewRoot @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class ChildPub extends Component<Empty, Empty> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'child-unmount' } });
      }
    }

    class OldRoot extends Component<Empty, Empty> {
      public override compose () {
        return [h(ChildPub, {})];
      }
    }

    class NewRoot extends Component<Empty, Empty> {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    const rt = await GraphRuntime.mount(h(OldRoot, {}), undefined, buses as any);
    await rt.reconcile(h(NewRoot, {}));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['child-unmount']);
    await rt.unmount();
  });

  it('OldRoot.onUnmount publish reaches NewRoot child @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class OldRoot extends Component<Empty, Empty> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'old-root-unmount' } });
      }
    }

    class Listener extends Component<Empty, Empty> {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class NewRoot extends Component<Empty, Empty> {
      public override compose () {
        return [h(Listener, {})];
      }
    }

    const rt = await GraphRuntime.mount(h(OldRoot, {}), undefined, buses as any);
    await rt.reconcile(h(NewRoot, {}));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['old-root-unmount']);
    await rt.unmount();
  });
});
