/**
 * Regression: deferred REPLACE victims (`pendingReplaceVictim`) are not in
 * `fiber.children`. When a later sibling throws before `flushSiblingBatchHooks`
 * (stable path: Early nested REPLACE, then Late `compose` throw), fail-stop
 * used to tear down only the live tree and leave the stashed victim's EventBus
 * subscribed — silent delivery after the runtime is FAILED.
 *
 * `destroyFiber` must reclaim `constructionJournal.pendingReplaceVictim` the
 * same way it already reclaims `pendingDeferredOrphans`.
 */
import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { OnEvent, OnCommand } from '../src/runtime/BusDecorators';

type Ev = { type: 'PING'; payload: { id: string } };
type Cmd = { type: 'DO'; payload?: undefined };
type Empty = Record<string, never>;

function buses () {
  return {
    eventBus: new EventBus<Ev>(),
    commandBus: new CommandBus<Cmd>(),
    queryBus: new QueryBus(),
  };
}

describe('GraphRuntime fail-stop reclaim of deferred REPLACE victims', () => {
  it('stable: Late compose throw after Early nested REPLACE — victim EventBus cleared', async () => {
    const seen: string[] = [];

    class Victim extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push('victim:' + e.payload.id);
      }

      @OnCommand('DO')
      public handle (): void {
        seen.push('victim-cmd');
      }
    }

    class Replacement extends Component<Empty, Empty> {
      @OnEvent('PING')
      public onPing (e: Ev): void {
        seen.push('repl:' + e.payload.id);
      }

      @OnCommand('DO')
      public handle (): void {
        seen.push('repl-cmd');
      }
    }

    class Early extends Component<{ flip: boolean }, { flip: boolean }> {
      public override compose () {
        return this.props.flip ? [h(Replacement, {})] : [h(Victim, {})];
      }
    }

    class Late extends Component<{ boom: boolean }, { boom: boolean }> {
      public override compose () {
        if (this.props.boom) {
          throw new Error('late-compose-boom');
        }
        return null;
      }
    }

    class Parent extends Component<
      { flip: boolean; boom: boolean },
      { flip: boolean; boom: boolean }
    > {
      public override compose () {
        // Same length/types → stable path; Early reconciles (stashes victim)
        // before Late compose throws — flushSiblingBatchHooks never runs.
        return [
          h(Early, { flip: this.props.flip }, 'e'),
          h(Late, { boom: this.props.boom }, 'l'),
        ];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(
      h(Parent, { flip: false, boom: false }),
      undefined,
      b as never,
    );

    await expect(
      rt.reconcile(h(Parent, { flip: true, boom: true })),
    ).rejects.toThrow(/late-compose-boom/);

    expect(rt.isActive()).toBe(false);

    b.eventBus.publish({ type: 'PING', payload: { id: 'after-fail' } });
    expect(seen).not.toContain('victim:after-fail');
    expect(seen).not.toContain('repl:after-fail');

    await rt.unmount();
  });

  it('stable: Late compose throw — exclusive Command already released on victim is not resurrected', async () => {
    const seen: string[] = [];

    class Victim extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void {
        seen.push('victim-cmd');
      }
    }

    class Replacement extends Component<Empty, Empty> {
      @OnCommand('DO')
      public handle (): void {
        seen.push('repl-cmd');
      }
    }

    class Early extends Component<{ flip: boolean }, { flip: boolean }> {
      public override compose () {
        return this.props.flip ? [h(Replacement, {})] : [h(Victim, {})];
      }
    }

    class Late extends Component<{ boom: boolean }, { boom: boolean }> {
      public override compose () {
        if (this.props.boom) {
          throw new Error('late-compose-boom-cmd');
        }
        return null;
      }
    }

    class Parent extends Component<
      { flip: boolean; boom: boolean },
      { flip: boolean; boom: boolean }
    > {
      public override compose () {
        return [
          h(Early, { flip: this.props.flip }, 'e'),
          h(Late, { boom: this.props.boom }, 'l'),
        ];
      }
    }

    const b = buses();
    const rt = await GraphRuntime.mount(
      h(Parent, { flip: false, boom: false }),
      undefined,
      b as never,
    );

    await expect(
      rt.reconcile(h(Parent, { flip: true, boom: true })),
    ).rejects.toThrow(/late-compose-boom-cmd/);

    expect(rt.isActive()).toBe(false);
    // Replacement torn down by fail-stop; victim exclusive was released at REPLACE
    // materialize and must not handle execute after FAILED.
    await expect(b.commandBus.execute({ type: 'DO' })).rejects.toThrow();
    expect(seen).not.toContain('victim-cmd');
    expect(seen).not.toContain('repl-cmd');

    await rt.unmount();
  });
});
