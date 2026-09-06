/**
 * Regression: depth-first materialize used to run earlier sibling onMount
 * (and its publishes) before later siblings finished @On* bus wiring, so
 * mount-time events were silently dropped.
 *
 * Distinct from parent-before-children (#97/#99): this is peer order under
 * the same parent.
 */

import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { UseEventBus, OnEvent } from '../src/runtime/BusDecorators';

type Ev = { type: 'READY'; payload: { id: string } };

function makeBuses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus(),
    queryBus: new QueryBus(),
  };
}

describe('GraphRuntime sibling bus mount order', () => {
  it('later sibling @OnEvent receives earlier sibling onMount publish', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Early extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onMount (): void {
        this.events.publish({ type: 'READY', payload: { id: 'early' } });
      }
    }

    class Late extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component {
      public override compose () {
        return [h(Early, {}, 'e'), h(Late, {}, 'l')];
      }
    }

    const rt = await GraphRuntime.mount(h(Parent, {}), undefined, buses as any);
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['early']);
    await rt.unmount();
  });

  it('PLACE siblings during reconcile: later @OnEvent receives earlier onMount publish', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Early extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onMount (): void {
        this.events.publish({ type: 'READY', payload: { id: 'placed-early' } });
      }
    }

    class Late extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        if (!this.props.show) {
          return [];
        }
        return [h(Early, {}, 'e'), h(Late, {}, 'l')];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { show: false }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { show: true }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['placed-early']);
    await rt.unmount();
  });

  it('three siblings: middle onMount publish reaches both earlier and later @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Listener extends Component<{ tag: string }, { tag: string }> {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(`${this.props.tag}:${e.payload.id}`);
      }
    }

    class Middle extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onMount (): void {
        this.events.publish({ type: 'READY', payload: { id: 'mid' } });
      }
    }

    class Parent extends Component {
      public override compose () {
        return [
          h(Listener, { tag: 'a' }, 'a'),
          h(Middle, {}, 'm'),
          h(Listener, { tag: 'c' }, 'c'),
        ];
      }
    }

    const rt = await GraphRuntime.mount(h(Parent, {}), undefined, buses as any);
    expect(rt.isActive()).toBe(true);
    // Compose order flush: a mounts (no publish), m publishes, c already wired → both hear mid.
    // a is flushed before m, so a is wired before m's onMount; c is wired during structure
    // phase before any flush — both receive.
    expect(seen.sort()).toEqual(['a:mid', 'c:mid']);
    await rt.unmount();
  });
});
