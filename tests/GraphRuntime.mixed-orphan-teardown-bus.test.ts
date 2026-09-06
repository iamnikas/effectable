/**
 * RED probe: mixed keyed + unkeyed orphan teardown must preserve compose order
 * so earlier siblings' onUnmount publishes still reach later siblings' @On*.
 *
 * Tip destroys remaining keyed orphans before remaining unkeyed orphans, which
 * inverts compose order when an unkeyed node precedes a keyed node.
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

describe('GraphRuntime mixed keyed/unkeyed orphan teardown bus', () => {
  it('unkeyed-before-keyed: earlier unkeyed onUnmount publish reaches later keyed @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class UnkeyedPublisher extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'unkeyed' } });
      }
    }

    class KeyedListener extends Component {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        if (!this.props.show) {
          return [];
        }
        // Unkeyed then keyed: compose order UnkeyedPublisher → KeyedListener.
        return [
          h(UnkeyedPublisher, {}),
          h(KeyedListener, {}, 'listener'),
        ];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { show: true }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { show: false }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['unkeyed']);
    await rt.unmount();
  });

  it('keyed-before-unkeyed: earlier keyed onUnmount publish reaches later unkeyed @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class KeyedPublisher extends Component {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'keyed' } });
      }
    }

    class UnkeyedListener extends Component {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(e.payload.id);
      }
    }

    class Parent extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        if (!this.props.show) {
          return [];
        }
        return [
          h(KeyedPublisher, {}, 'publisher'),
          h(UnkeyedListener, {}),
        ];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { show: true }),
      undefined,
      buses as any,
    );
    await rt.reconcile(h(Parent, { show: false }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['keyed']);
    await rt.unmount();
  });
});
