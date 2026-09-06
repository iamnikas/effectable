/**
 * Regression: root REPLACE wires the replacement, destroys the victim, then flushes
 * deferred lifecycle. A *descendant* onMount throw used to roll back only that
 * descendant and rethrow — the replacement root (already @OnCommand-wired) was never
 * destroyed. failStop then tore down currentRoot (the already-destroyed victim), so
 * exclusive handlers remained on shared buses and blocked remount.
 *
 * Distinct from #157 (wire-before-destroy handoff) and sibling PLACE HOLE 3 cleanup.
 */

import { Component } from '../src/component/Component';
import { GraphRuntime } from '../src/component/GraphRuntime';
import { h } from '../src/component/h';
import { EventBus } from '../src/runtime/EventBus';
import { CommandBus } from '../src/runtime/CommandBus';
import { QueryBus } from '../src/runtime/QueryBus';
import { OnCommand } from '../src/runtime/BusDecorators';

type Cmd = { type: 'DO'; payload: Record<string, never> };

function buses () {
  return {
    eventBus: new EventBus(),
    commandBus: new CommandBus<Cmd>(),
    queryBus: new QueryBus(),
  };
}

describe('GraphRuntime root REPLACE descendant onMount bus leak', () => {
  it('descendant onMount throw after root REPLACE does not leave @OnCommand on shared buses', async () => {
    const b = buses();
    const log: string[] = [];

    class OldRoot extends Component {
      public override onUnmount (): void {
        log.push('old-unmount');
      }
    }

    class BoomChild extends Component {
      public override onMount (): void {
        log.push('boom-child-mount');
        throw new Error('boom-child-mount');
      }
    }

    class WiredNewRoot extends Component {
      @OnCommand('DO')
      public handle (): void {
        log.push('wired-handle');
      }

      public override compose () {
        return [h(BoomChild, {}, 'boom')];
      }
    }

    class CleanRoot extends Component {
      @OnCommand('DO')
      public handle (): void {
        log.push('clean-handle');
      }
    }

    const rt = await GraphRuntime.mount(h(OldRoot, {}), undefined, b as any);
    await expect(rt.reconcile(h(WiredNewRoot, {}))).rejects.toThrow(/boom-child-mount/);
    expect(rt.isActive()).toBe(false);
    expect(log).toEqual(expect.arrayContaining(['old-unmount', 'boom-child-mount']));

    const rt2 = await GraphRuntime.mount(h(CleanRoot, {}), undefined, b as any);
    expect(rt2.isActive()).toBe(true);
    await expect(b.commandBus.execute({ type: 'DO', payload: {} })).resolves.toBeUndefined();
    expect(log).toContain('clean-handle');
    await rt2.unmount();
  });

  it('replacement root onMount throw still cleans exclusive @OnCommand (rollback path)', async () => {
    const b = buses();

    class OldRoot extends Component {}

    class BoomRoot extends Component {
      @OnCommand('DO')
      public handle (): void {}

      public override onMount (): void {
        throw new Error('boom-root-mount');
      }
    }

    class CleanRoot extends Component {
      @OnCommand('DO')
      public handle (): void {}
    }

    const rt = await GraphRuntime.mount(h(OldRoot, {}), undefined, b as any);
    await expect(rt.reconcile(h(BoomRoot, {}))).rejects.toThrow(/boom-root-mount/);
    expect(rt.isActive()).toBe(false);

    await expect(GraphRuntime.mount(h(CleanRoot, {}), undefined, b as any)).resolves.toBeDefined();
  });
});
