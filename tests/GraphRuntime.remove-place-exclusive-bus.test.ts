/**
 * REMOVE+PLACE exclusive bus handoff: free Command/Query slots on orphan subtrees
 * before PLACE, without early EventBus unsubscribe (REPLACE victim → live orphan).
 */
import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import {
  OnCommand,
  OnQuery,
  OnEvent,
  UseEventBus,
} from '../src/runtime/BusDecorators';

type Cmd = { type: 'DO'; payload: { id: string } };
type Q = { type: 'GET'; payload: Record<string, never> };
type Ev = { type: 'BYE'; payload: { id: string } };
type PhaseProps = { phase: 1 | 2 };

function buses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus<Cmd>(),
    queryBus: new QueryBus<Q>(),
  };
}

describe('GraphRuntime REMOVE+PLACE exclusive bus handoff', () => {
  it('keyed REMOVE+PLACE same OnCommand does not fail-stop', async () => {
    class OldHandler extends Component<unknown, Record<string, never>> {
      @OnCommand('DO')
      public handle (): void { /* old */ }
    }
    class NewHandler extends Component<unknown, Record<string, never>> {
      @OnCommand('DO')
      public handle (): void { /* new */ }
    }
    class Parent extends Component<unknown, PhaseProps> {
      public override compose () {
        return this.props.phase === 1
          ? [h(OldHandler, {}, 'old')]
          : [h(NewHandler, {}, 'new')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as never);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });

  it('keyed REMOVE+PLACE same OnQuery does not fail-stop', async () => {
    class OldQ extends Component<unknown, Record<string, never>> {
      @OnQuery('GET')
      public handle (): number { return 1; }
    }
    class NewQ extends Component<unknown, Record<string, never>> {
      @OnQuery('GET')
      public handle (): number { return 2; }
    }
    class Parent extends Component<unknown, PhaseProps> {
      public override compose () {
        return this.props.phase === 1
          ? [h(OldQ, {}, 'a')]
          : [h(NewQ, {}, 'b')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as never);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.queryBus.execute({ type: 'GET', payload: {} })).resolves.toBe(2);
    await rt.unmount();
  });

  it('nested orphan OnCommand REMOVE+PLACE does not fail-stop', async () => {
    class NestedOld extends Component<unknown, Record<string, never>> {
      @OnCommand('DO')
      public handle (): void { /* old nested */ }
    }
    class Wrapper extends Component<unknown, Record<string, never>> {
      public override compose () {
        return [h(NestedOld)];
      }
    }
    class NestedNew extends Component<unknown, Record<string, never>> {
      @OnCommand('DO')
      public handle (): void { /* new */ }
    }
    class Parent extends Component<unknown, PhaseProps> {
      public override compose () {
        return this.props.phase === 1
          ? [h(Wrapper, {}, 'old')]
          : [h(NestedNew, {}, 'new')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as never);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });

  it('nested orphan OnQuery REMOVE+PLACE does not fail-stop', async () => {
    class NestedOldQ extends Component<unknown, Record<string, never>> {
      @OnQuery('GET')
      public handle (): number { return 1; }
    }
    class Wrapper extends Component<unknown, Record<string, never>> {
      public override compose () {
        return [h(NestedOldQ)];
      }
    }
    class NestedNewQ extends Component<unknown, Record<string, never>> {
      @OnQuery('GET')
      public handle (): number { return 2; }
    }
    class Parent extends Component<unknown, PhaseProps> {
      public override compose () {
        return this.props.phase === 1
          ? [h(Wrapper, {}, 'a')]
          : [h(NestedNewQ, {}, 'b')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as never);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.queryBus.execute({ type: 'GET', payload: {} })).resolves.toBe(2);
    await rt.unmount();
  });

  it('orphan still hears REPLACE victim onUnmount EventBus publish', async () => {
    const seen: string[] = [];

    class Victim extends Component<unknown, Record<string, never>> {
      @UseEventBus() declare events: EventBus<Ev>;
      public override onUnmount (): void {
        this.events.publish({ type: 'BYE', payload: { id: 'victim' } });
      }
    }
    class OrphanListener extends Component<unknown, Record<string, never>> {
      @OnEvent('BYE')
      public onBye (e: Ev): void {
        seen.push(`orphan:${e.payload.id}`);
      }
    }
    class Replacement extends Component<unknown, Record<string, never>> {}
    class Parent extends Component<unknown, PhaseProps> {
      public override compose () {
        return this.props.phase === 1
          ? [h(Victim, {}, 'a'), h(OrphanListener, {}, 'b')]
          : [h(Replacement, {}, 'a')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as never);
    await rt.reconcile(h(Parent, { phase: 2 }));
    expect(rt.isActive()).toBe(true);
    expect(seen).toEqual(['orphan:victim']);
    await rt.unmount();
  });
});
