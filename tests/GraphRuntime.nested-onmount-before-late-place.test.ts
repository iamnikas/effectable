/**
 * Regression: Early UPDATE nested PLACE `onMount` publish must reach Late UPDATE
 * nested PLACE `@OnEvent` handlers.
 *
 * Sibling PLACE batches already defer onMount until later peers wire (control case).
 * But a nested PLACE under Early still flushed deferred lifecycle inside Early's own
 * `reconcileChildren` → `flushSiblingBatchHooks` — before Late nested PLACE registered
 * `@OnEvent`. Silent event loss (stable + full-diff).
 *
 * Related: nested onUpdate under Early before Late PLACE is the same deferral class
 * (covered here too; a prior onUpdate-only deferral still flushed onMount early).
 */
import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { UseEventBus, OnEvent } from '../src/runtime/BusDecorators';

type Ev = { type: 'PING'; payload: { id: string } };
type Empty = Record<string, never>;

function makeBuses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus(),
    queryBus: new QueryBus(),
  };
}

describe('GraphRuntime nested onMount before late nested PLACE', () => {
  it('CONTROL: sibling PLACE onMount publish reaches later sibling @OnEvent', async () => {
    const seen: string[] = [];

    class Pub extends Component<Empty, Empty> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onMount (): void {
        this.events.publish({ type: 'PING', payload: { id: 'sib' } });
      }
    }

    class Listener extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show
          ? [h(Pub, {}, 'p'), h(Listener, {}, 'l')]
          : [];
      }
    }

    const buses = makeBuses();
    const rt = await GraphRuntime.mount(h(Parent, { show: false }), undefined, buses as never);
    await rt.reconcile(h(Parent, { show: true }));
    expect(seen).toEqual(['sib']);
    await rt.unmount();
  });

  it('stable: Early nested PLACE onMount publish reaches Late nested @OnEvent', async () => {
    const seen: string[] = [];

    class NestedPub extends Component<Empty, Empty> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onMount (): void {
        this.events.publish({ type: 'PING', payload: { id: 'mount' } });
      }
    }

    class Early extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(NestedPub, {})] : [];
      }
    }

    class Listener extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Late extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(Listener, {})] : [];
      }
    }

    class Parent extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        // Same length/types → stable path
        return [
          h(Early, { show: this.props.show }, 'e'),
          h(Late, { show: this.props.show }, 'l'),
        ];
      }
    }

    const buses = makeBuses();
    const rt = await GraphRuntime.mount(h(Parent, { show: false }), undefined, buses as never);
    await rt.reconcile(h(Parent, { show: true }));
    expect(seen).toEqual(['mount']);
    await rt.unmount();
  });

  it('fulldiff: Early nested PLACE onMount + orphan reaches Late nested @OnEvent', async () => {
    const seen: string[] = [];

    class NestedPub extends Component<Empty, Empty> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onMount (): void {
        this.events.publish({ type: 'PING', payload: { id: 'mount' } });
      }
    }

    class Early extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(NestedPub, {})] : [];
      }
    }

    class Listener extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Late extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(Listener, {})] : [];
      }
    }

    class Orphan extends Component<Empty, Empty> {}

    class Parent extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show
          ? [
              h(Early, { show: true }, 'e'),
              h(Late, { show: true }, 'l'),
            ]
          : [
              h(Early, { show: false }, 'e'),
              h(Late, { show: false }, 'l'),
              h(Orphan, {}, 'o'),
            ];
      }
    }

    const buses = makeBuses();
    const rt = await GraphRuntime.mount(h(Parent, { show: false }), undefined, buses as never);
    await rt.reconcile(h(Parent, { show: true }));
    expect(seen).toEqual(['mount']);
    await rt.unmount();
  });

  it('stable: nested onUpdate under Early reaches Late nested PLACE @OnEvent', async () => {
    const seen: string[] = [];

    class NestedPub extends Component<{ n: number }, { n: number }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (prev: { n: number }): void {
        if (prev.n !== this.props.n) {
          this.events.publish({ type: 'PING', payload: { id: `n=${this.props.n}` } });
        }
      }
    }

    class Early extends Component<{ n: number }, { n: number }> {
      public override compose () {
        return [h(NestedPub, { n: this.props.n })];
      }
    }

    class Listener extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Late extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(Listener, {})] : [];
      }
    }

    class Parent extends Component<{ n: number; show: boolean }, { n: number; show: boolean }> {
      public override compose () {
        return [
          h(Early, { n: this.props.n }, 'e'),
          h(Late, { show: this.props.show }, 'l'),
        ];
      }
    }

    const buses = makeBuses();
    const rt = await GraphRuntime.mount(
      h(Parent, { n: 1, show: false }),
      undefined,
      buses as never,
    );
    await rt.reconcile(h(Parent, { n: 2, show: true }));
    expect(seen).toEqual(['n=2']);
    await rt.unmount();
  });
});
