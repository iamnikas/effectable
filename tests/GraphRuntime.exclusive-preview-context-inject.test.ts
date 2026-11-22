/**
 * Regression: exclusive pre-PLACE preview under a deferred UPDATE must mirror
 * real updateFiber context wiring. If compose drops a nested `@OnCommand` based
 * on `@UseContext` fields from a new parent scope, preview without inject keeps
 * the old tree and fails to free the exclusive slot before same-batch PLACE.
 */
import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import {
  ContextProvider,
  UseContext,
  createContext,
} from '../src/component/context';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { OnCommand } from '../src/runtime/BusDecorators';

type Cmd = { type: 'DO'; payload: { id: string } };
type Q = { type: 'GET'; payload: Record<string, never> };
type Ev = { type: 'READY'; payload: { id: string } };
type Empty = Record<string, never>;

const SHOW_INNER = createContext<boolean>('SHOW_INNER');

function buses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus<Cmd>(),
    queryBus: new QueryBus<Q>(),
  };
}

describe('GraphRuntime exclusive preview + context inject', () => {
  it('deferred UPDATE compose via @UseContext frees OnCommand before PLACE sibling', async () => {
    class Inner extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* nested under Keeper while context says keep */ }
    }

    class Keeper extends Component<Empty, Empty> {
      @UseContext(SHOW_INNER)
      public showInner = true;

      public override compose () {
        return this.showInner ? [h(Inner, {})] : [];
      }
    }

    class NewHandler extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* PLACE sibling claiming DO */ }
    }

    class Parent extends Component<
      { showInner: boolean; place: boolean },
      { showInner: boolean; place: boolean }
    > {
      public override compose () {
        const kids = [h(Keeper, {}, 'k')];
        if (this.props.place) {
          kids.push(h(NewHandler, {}, 'n'));
        }
        return [
          h(ContextProvider, { value: [SHOW_INNER, this.props.showInner] }, kids),
        ];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(
      h(Parent, { showInner: true, place: false }),
      undefined,
      b as never,
    );

    await expect(
      rt.reconcile(h(Parent, { showInner: false, place: true })),
    ).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(
      b.commandBus.execute({ type: 'DO', payload: { id: 'x' } }),
    ).resolves.toBeUndefined();
    await rt.unmount();
  });
});
