/**
 * Regression: full-diff orphan exclusive release only inspected the *incoming sibling
 * root* type (#178). Nested `@OnCommand` / `@OnQuery` under a PLACE wrapper, or under
 * a deferred UPDATE's nested PLACE, still collided with a leaving orphan → fail-stop.
 *
 * Distinct from #182/#190 (exclusive under a *surviving* later UPDATE sibling) and from
 * sibling-root PLACE vs orphan (#178 control below).
 */
import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { OnCommand, OnQuery } from '../src/runtime/BusDecorators';

type Cmd = { type: 'DO'; payload: { id: string } };
type Q = { type: 'GET'; payload: Record<string, never> };
type Ev = { type: 'X'; payload: Record<string, never> };
type Empty = Record<string, never>;

function buses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus<Cmd>(),
    queryBus: new QueryBus<Q>(),
  };
}

describe('GraphRuntime nested PLACE vs orphan exclusive', () => {
  it('CONTROL: sibling-root PLACE vs keyed orphan @OnCommand (#178)', async () => {
    class OldHandler extends Component {
      @OnCommand('DO')
      public handle (): void { /* orphan */ }
    }
    class NewHandler extends Component {
      @OnCommand('DO')
      public handle (): void { /* PLACE root */ }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(OldHandler, {}, 'old')]
          : [h(NewHandler, {}, 'new')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });

  it('PLACE Wrapper>Handler@DO vs keyed orphan Old@DO', async () => {
    class Handler extends Component {
      @OnCommand('DO')
      public handle (): void { /* nested under PLACE wrapper */ }
    }
    class Wrapper extends Component {
      public override compose () {
        return [h(Handler, {})];
      }
    }
    class Old extends Component {
      @OnCommand('DO')
      public handle (): void { /* orphan */ }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(Old, {}, 'old')]
          : [h(Wrapper, {}, 'new')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });

  it('Command: Early UPDATE nested PLACE vs keyed orphan Middle@DO', async () => {
    class Handler extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* PLACE under Early */ }
    }
    class MiddleHolder extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* orphan */ }
    }
    class Early extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(Handler, {})] : [];
      }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(Early, { show: false }, 'e'), h(MiddleHolder, {}, 'm')]
          : [h(Early, { show: true }, 'e')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });

  it('Query: Early UPDATE nested PLACE vs keyed orphan Middle@GET', async () => {
    class HandlerQ extends Component {
      @OnQuery('GET')
      public handle (): number { return 2; }
    }
    class MiddleQ extends Component {
      @OnQuery('GET')
      public handle (): number { return 1; }
    }
    class EarlyQ extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(HandlerQ, {})] : [];
      }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(EarlyQ, { show: false }, 'e'), h(MiddleQ, {}, 'm')]
          : [h(EarlyQ, { show: true }, 'e')];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.queryBus.execute({ type: 'GET', payload: {} })).resolves.toBe(2);
    await rt.unmount();
  });

  it('unkeyed: Early UPDATE nested PLACE vs trailing orphan@DO', async () => {
    class Handler extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* PLACE */ }
    }
    class MiddleHolder extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void { /* orphan */ }
    }
    class Early extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show ? [h(Handler, {})] : [];
      }
    }
    class Parent extends Component<{ phase: 1 | 2 }, { phase: 1 | 2 }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(Early, { show: false }), h(MiddleHolder, {})]
          : [h(Early, { show: true })];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(h(Parent, { phase: 1 }), undefined, b as any);
    await expect(rt.reconcile(h(Parent, { phase: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: { id: 'x' } })).resolves.toBeUndefined();
    await rt.unmount();
  });

  it('UPDATE onUpdate execute still reaches orphan when no nested PLACE claims DO (#158)', async () => {
    const seen: string[] = [];
    class Holder extends Component {
      @OnCommand('DO')
      public handle (c: Cmd): void { seen.push(c.payload.id); }
    }
    class Publisher extends Component<{ n: number }, { n: number }> {
      public override onUpdate (prev: { n: number }): void {
        if (prev.n !== this.props.n) {
          void busesRef.commandBus.execute({ type: 'DO', payload: { id: `n=${this.props.n}` } });
        }
      }
      public override compose () {
        return [];
      }
    }

    const busesRef = buses();
    class Root extends Component<{ phase: 1 | 2; n: number }, { phase: 1 | 2; n: number }> {
      public override compose () {
        return this.props.phase === 1
          ? [h(Publisher, { n: this.props.n }, 'p'), h(Holder, {}, 'h')]
          : [h(Publisher, { n: this.props.n }, 'p')];
      }
    }

    const rt = await GraphRuntime.mount(h(Root, { phase: 1, n: 1 }), undefined, busesRef as any);
    await expect(rt.reconcile(h(Root, { phase: 2, n: 2 }))).resolves.toBeUndefined();
    expect(rt.isActive()).toBe(true);
    // Publisher onUpdate runs before orphan destroy; Holder must still be wired.
    expect(seen).toEqual(['n=2']);
    await rt.unmount();
  });
});
