/**
 * RED probe: full-diff pass-2 UPDATE must defer onUpdate until later UPDATE
 * siblings finish nested PLACE bus wiring (#125 covered sibling PLACE only).
 */
import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { UseEventBus, OnEvent } from '../src/runtime/BusDecorators';

type Ev = { type: 'PING'; payload: { id: string } };

function makeBuses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus(),
    queryBus: new QueryBus(),
  };
}

describe('GraphRuntime full-diff onUpdate vs nested PLACE', () => {
  it('control (stable): Early onUpdate reaches Late nested PLACE @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Early extends Component<{ n: number }, { n: number }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (): void {
        this.events.publish({ type: 'PING', payload: { id: `early-${this.props.n}` } });
      }
      public override compose () {
        return null;
      }
    }

    class Listener extends Component {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push(e.payload.id);
      }
      public override compose () {
        return null;
      }
    }

    class Late extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? h(Listener, {}, 'listener') : null;
      }
    }

    class Parent extends Component<{ n: number; show: boolean }, { n: number; show: boolean }> {
      public override compose () {
        return [
          h(Early, { n: this.props.n }, 'early'),
          h(Late, { show: this.props.show }, 'late'),
        ];
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { n: 1, show: false }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { n: 2, show: true }) as any);
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['early-2']);
    await rt.unmount();
  });

  it('full-diff (orphan Extra): Early onUpdate reaches Late nested PLACE @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Early extends Component<{ n: number }, { n: number }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUpdate (): void {
        this.events.publish({ type: 'PING', payload: { id: `early-${this.props.n}` } });
      }
      public override compose () {
        return null;
      }
    }

    class Listener extends Component {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push(e.payload.id);
      }
      public override compose () {
        return null;
      }
    }

    class Late extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? h(Listener, {}, 'listener') : null;
      }
    }

    class Extra extends Component {
      public override compose () {
        return null;
      }
    }

    class Parent extends Component<
      { n: number; show: boolean; extra: boolean },
      { n: number; show: boolean; extra: boolean }
    > {
      public override compose () {
        const kids: Array<ReturnType<typeof h>> = [
          h(Early, { n: this.props.n }, 'early'),
          h(Late, { show: this.props.show }, 'late'),
        ];
        if (this.props.extra) {
          kids.push(h(Extra, {}, 'extra'));
        }
        return kids;
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { n: 1, show: false, extra: true }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { n: 2, show: true, extra: false }) as any);
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['early-2']);
    await rt.unmount();
  });
});
