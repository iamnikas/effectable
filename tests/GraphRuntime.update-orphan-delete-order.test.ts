/**
 * Regression: #119 deferred same-batch UPDATE until after PLACE/REPLACE wiring, but
 * also destroyed orphans *before* those UPDATEs. That inverted pre-#119 UPDATE↔DELETE
 * order — onUpdate ran after sibling onUnmount, so handoff publishes were dropped and
 * surviving listeners still saw stale props.
 *
 * Contract: PLACE/REPLACE peers wire first; deferred UPDATE onUpdate runs next; then
 * orphan onUnmount; then deferred onMount flush.
 */

import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { UseEventBus, OnEvent } from '../src/runtime/BusDecorators';

type Ev = { type: 'READY' | 'BYE'; payload: { id: string } };

function makeBuses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus(),
    queryBus: new QueryBus(),
  };
}

describe('GraphRuntime UPDATE vs orphan DELETE order', () => {
  it('keyed: UPDATE onUpdate publish reaches same-batch DELETED sibling before unmount', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

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
        seen.push(`ready:${e.payload.id}`);
      }
      public override onUnmount (): void {
        seen.push('listener-unmount');
      }
    }

    class Parent extends Component<{ n: number; keep: boolean }, { n: number; keep: boolean }> {
      public override compose () {
        if (this.props.keep) {
          return [
            h(Publisher, { n: this.props.n }, 'p'),
            h(Listener, {}, 'l'),
          ];
        }
        return [h(Publisher, { n: this.props.n }, 'p')];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { n: 1, keep: true }),
      undefined,
      buses as any,
    );
    seen.length = 0;

    await rt.reconcile(h(Parent, { n: 2, keep: false }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['ready:n=2', 'listener-unmount']);
    await rt.unmount();
  });

  it('keyed: orphan onUnmount reaches UPDATE sibling with already-updated props', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Keeper extends Component<{ n: number }, { n: number }> {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(`bye@n=${this.props.n}:${e.payload.id}`);
      }
      public override onUpdate (prev: { n: number }): void {
        seen.push(`update:${prev.n}->${this.props.n}`);
      }
    }

    class Victim extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'orphan' } });
      }
    }

    class Parent extends Component<{ n: number; keep: boolean }, { n: number; keep: boolean }> {
      public override compose () {
        if (this.props.keep) {
          return [
            h(Keeper, { n: this.props.n }, 'k'),
            h(Victim, {}, 'v'),
          ];
        }
        return [h(Keeper, { n: this.props.n }, 'k')];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { n: 1, keep: true }),
      undefined,
      buses as any,
    );
    seen.length = 0;

    await rt.reconcile(h(Parent, { n: 2, keep: false }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['update:1->2', 'bye@n=2:orphan']);
    await rt.unmount();
  });

  it('UPDATE+PLACE+DELETE: onUpdate still reaches new PLACE after orphan teardown order restore', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Publisher extends Component<{ n: number }, { n: number }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (prev: { n: number }): void {
        if (prev.n !== this.props.n) {
          this.events.publish({ type: 'READY', payload: { id: `n=${this.props.n}` } });
        }
      }
    }

    class OldListener extends Component {
      public override onUnmount (): void {
        seen.push('old-unmount');
      }
    }

    class NewListener extends Component {
      @OnEvent('READY')
      public onReady (e: Ev): void {
        seen.push(`ready:${e.payload.id}`);
      }
    }

    class Parent extends Component<{ n: number; phase: 1 | 2 }, { n: number; phase: 1 | 2 }> {
      public override compose () {
        if (this.props.phase === 1) {
          return [
            h(Publisher, { n: this.props.n }, 'p'),
            h(OldListener, {}, 'old'),
          ];
        }
        return [
          h(Publisher, { n: this.props.n }, 'p'),
          h(NewListener, {}, 'new'),
        ];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { n: 1, phase: 1 }),
      undefined,
      buses as any,
    );
    seen.length = 0;

    await rt.reconcile(h(Parent, { n: 2, phase: 2 }));
    expect(rt.isActive()).toBe(true);
    // PLACE wires before UPDATE; UPDATE before orphan onUnmount; READY reaches NewListener.
    expect(seen).toEqual(['ready:n=2', 'old-unmount']);
    await rt.unmount();
  });
});
