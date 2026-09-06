/**
 * Regression: parent pass-1 PLACE can register `@OnCommand` / `@OnQuery` while a
 * deferred UPDATE sibling still holds a nested exclusive handler that will only be
 * removed in pass-2 (when the wrapper's children reconcile).
 *
 * Distinct from:
 * - #170 nested exclusive under orphans (wrapper itself leaves)
 * - #177 PLACE-before-REPLACE victims (type/key REPLACE, not UPDATE)
 * - #173 root REPLACE exclusive pre-dispose
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
type Ev = { type: 'PING'; payload: { id: string } };

function buses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus<Cmd>(),
    queryBus: new QueryBus<Q>(),
  };
}

describe('GraphRuntime UPDATE-nested exclusive vs sibling PLACE', () => {
  it('PLACE @OnCommand does not fail-stop while UPDATE still holds nested handler', async () => {
    const hits: string[] = [];
    const b = buses();

    class OldHandler extends Component {
      @OnCommand('DO')
      public handle (): void {
        hits.push('old');
      }
    }
    class NewHandler extends Component {
      @OnCommand('DO')
      public handle (): void {
        hits.push('new');
      }
    }
    class Wrapper extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(OldHandler, {}, 'old')] : [];
      }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        if (this.props.phase === 1) {
          return [h(Wrapper, { show: true }, 'w')];
        }
        return [
          h(Wrapper, { show: false }, 'w'),
          h(NewHandler, {}, 'n'),
        ];
      }
    }

    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await b.commandBus.execute({ type: 'DO', payload: { id: 'x' } });
    expect(hits).toEqual(['new']);
    await rt.unmount();
  });

  it('PLACE @OnQuery does not fail-stop while UPDATE still holds nested handler', async () => {
    const b = buses();

    class OldQ extends Component {
      @OnQuery('GET')
      public handle (): number {
        return 1;
      }
    }
    class NewQ extends Component {
      @OnQuery('GET')
      public handle (): number {
        return 2;
      }
    }
    class Wrapper extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(OldQ, {}, 'old')] : [];
      }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(Wrapper, { show: true }, 'w')]
          : [h(Wrapper, { show: false }, 'w'), h(NewQ, {}, 'n')];
      }
    }

    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.queryBus.execute({ type: 'GET', payload: {} })).resolves.toBe(2);
    await rt.unmount();
  });

  it('UPDATE nested onUnmount EventBus publish still reaches earlier PLACE @OnEvent', async () => {
    const seen: string[] = [];
    const b = buses();

    class NestedPublisher extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'PING', payload: { id: 'nested' } });
      }
    }
    class Listener extends Component {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push(e.payload.id);
      }
    }
    class Wrapper extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(NestedPublisher, {}, 'p')] : [];
      }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(Wrapper, { show: true }, 'w')]
          : [h(Listener, {}, 'l'), h(Wrapper, { show: false }, 'w')];
      }
    }

    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await rt.reconcile(h(Parent, { phase: 2 }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['nested']);
    await rt.unmount();
  });
});
