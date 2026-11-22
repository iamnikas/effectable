/**
 * UPDATE onUpdate (or parent onUpdate) must not publish before later PLACE
 * siblings / children have @On* buses wired — same silent-drop class as #108
 * (onMount defer), different hook.
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

describe('GraphRuntime onUpdate before PLACE bus wiring', () => {
  it('UPDATE sibling onUpdate publish reaches later PLACE @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Early extends Component<{ n: number }, { n: number }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public constructor (props: { n: number }) {
        super(props);
        this.state = { n: props.n };
      }
      public override onUpdate (): void {
        this.events.publish({ type: 'PING', payload: { id: `early-${this.props.n}` } });
      }
      public override compose () {
        return null;
      }
    }

    class Late extends Component {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push(e.payload.id);
      }
      public override compose () {
        return null;
      }
    }

    class Parent extends Component<{ showLate: boolean; n: number }, { showLate: boolean; n: number }> {
      public constructor (props: { showLate: boolean; n: number }) {
        super(props);
        this.state = { ...props };
      }
      public override compose () {
        const kids: ReturnType<typeof h>[] = [h(Early, { n: this.props.n }, 'e')];
        if (this.props.showLate) {
          kids.push(h(Late, {}, 'l'));
        }
        return kids;
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { showLate: false, n: 1 } as { showLate: boolean; n: number }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { showLate: true, n: 2 } as { showLate: boolean; n: number }));
    expect(seen).toEqual(['early-2']);
    await rt.unmount();
  });

  it('parent onUpdate publish reaches same-pass PLACE child @OnEvent', async () => {
    const seen: string[] = [];
    const buses = makeBuses();

    class Child extends Component {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push(e.payload.id);
      }
      public override compose () {
        return null;
      }
    }

    class Parent extends Component<{ show: boolean; n: number }, { show: boolean; n: number }> {
      @UseEventBus() declare events: EventBus<Ev>;
      public constructor (props: { show: boolean; n: number }) {
        super(props);
        this.state = { ...props };
      }
      public override onUpdate (): void {
        this.events.publish({ type: 'PING', payload: { id: `parent-${this.props.n}` } });
      }
      public override compose () {
        return this.props.show ? h(Child, {}, 'c') : null;
      }
    }

    const rt = await GraphRuntime.mount(
      h(Parent, { show: false, n: 1 } as { show: boolean; n: number }),
      undefined,
      buses as any,
    );
    expect(seen).toEqual([]);

    await rt.reconcile(h(Parent, { show: true, n: 2 } as { show: boolean; n: number }));
    expect(seen).toEqual(['parent-2']);
    await rt.unmount();
  });
});
