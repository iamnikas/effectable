/**
 * Regression: `destroyFiber` clears `pendingDeferredOrphans` then used to
 * `return orphanRes.then(() => destroyFiber(fiber))` on the first async orphan
 * destroy — dropping later entries in the local stash. Fail-stop after Early
 * stashes multiple nested orphans and the first has async `onUnmount` left the
 * later orphan's EventBus subscribed after the runtime is FAILED.
 */
import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { OnEvent } from '../src/runtime/BusDecorators';

type Ev = { type: 'PING'; payload: { id: string } };
type Empty = Record<string, never>;

function makeBuses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus(),
    queryBus: new QueryBus(),
  };
}

describe('GraphRuntime fail-stop multi deferred-orphan async reclaim', () => {
  it('stable: first orphan async onUnmount — later orphan EventBus cleared', async () => {
    const seen: string[] = [];

    class OrphanA extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push('a:' + e.payload.id);
      }
      public override async onUnmount (): Promise<void> {
        await Promise.resolve();
        seen.push('a-unmount');
      }
    }

    class OrphanB extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push('b:' + e.payload.id);
      }
    }

    class Early extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show
          ? [h(OrphanA, {}, 'a'), h(OrphanB, {}, 'b')]
          : [];
      }
    }

    class Late extends Component<{ boom: boolean }, { boom: boolean }> {
      public override compose () {
        if (this.props.boom) {
          throw new Error('late-boom-multi-orphan-async');
        }
        return null;
      }
    }

    class Parent extends Component<
      { early: boolean; boom: boolean },
      { early: boolean; boom: boolean }
    > {
      public override compose () {
        // Same length → stable sibling batch: Early stashes both orphans under
        // deferPendingBatchFlush; Late compose throws before flush drains them.
        return [
          h(Early, { show: this.props.early }, 'e'),
          h(Late, { boom: this.props.boom }, 'l'),
        ];
      }
    }

    const buses = makeBuses();
    const rt = await GraphRuntime.mount(
      h(Parent, { early: true, boom: false }),
      undefined,
      buses as never,
    );

    await expect(
      rt.reconcile(h(Parent, { early: false, boom: true })),
    ).rejects.toThrow(/late-boom-multi-orphan-async/);

    // Fail-stop may return before async orphan drain finishes — settle the queue.
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));

    expect(rt.isActive()).toBe(false);
    expect(seen).toContain('a-unmount');

    buses.eventBus.publish({ type: 'PING', payload: { id: 'after-fail' } });
    expect(seen).not.toContain('a:after-fail');
    expect(seen).not.toContain('b:after-fail');

    await rt.unmount();
  });

  it('stable: two sync deferred orphans — both EventBus cleared', async () => {
    const seen: string[] = [];

    class OrphanA extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push('a:' + e.payload.id);
      }
    }

    class OrphanB extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push('b:' + e.payload.id);
      }
    }

    class Early extends Component<{ show: boolean }, { show: boolean }> {
      public override compose () {
        return this.props.show
          ? [h(OrphanA, {}, 'a'), h(OrphanB, {}, 'b')]
          : [];
      }
    }

    class Late extends Component<{ boom: boolean }, { boom: boolean }> {
      public override compose () {
        if (this.props.boom) {
          throw new Error('late-boom-multi-orphan-sync');
        }
        return null;
      }
    }

    class Parent extends Component<
      { early: boolean; boom: boolean },
      { early: boolean; boom: boolean }
    > {
      public override compose () {
        return [
          h(Early, { show: this.props.early }, 'e'),
          h(Late, { boom: this.props.boom }, 'l'),
        ];
      }
    }

    const buses = makeBuses();
    const rt = await GraphRuntime.mount(
      h(Parent, { early: true, boom: false }),
      undefined,
      buses as never,
    );

    await expect(
      rt.reconcile(h(Parent, { early: false, boom: true })),
    ).rejects.toThrow(/late-boom-multi-orphan-sync/);

    expect(rt.isActive()).toBe(false);
    buses.eventBus.publish({ type: 'PING', payload: { id: 'after-fail' } });
    expect(seen).not.toContain('a:after-fail');
    expect(seen).not.toContain('b:after-fail');

    await rt.unmount();
  });
});
