/**
 * Materialize rollback correctness:
 * 1. Parent never reached onMount → rollback must not call parent onUnmount
 *    (rollbackFailedMaterialization previously hard-coded wasMounted=true).
 * 2. compose()/validateUniqueKeys throw after premount hook → failing fiber
 *    must self-rollback (clear scheduler hook); parent rollback alone cannot
 *    see it because it was never pushed to journal.mountedChildren.
 */
import { Component, GraphRuntime, h } from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';
import { SCHEDULE_UPDATE_HOOK } from 'Effectable/component/types';

describe('GraphRuntime materialize rollback (pre-startup)', () => {
  test('child onMount failure must not call parent onUnmount when parent never mounted', async () => {
    const parentUnmountCalls: string[] = [];

    class OkChild extends Component<Record<string, never>, Record<string, never>> {
      public override onMount (): void {
        /* mounted successfully */
      }
    }

    class FailChild extends Component<Record<string, never>, Record<string, never>> {
      public override onMount (): void {
        throw new Error('FailChild: intentional mount failure');
      }
    }

    class Parent extends Component<Record<string, never>, Record<string, never>> {
      public override onMount (): void {
        parentUnmountCalls.push('parent-mounted');
      }

      public override onUnmount (): void {
        parentUnmountCalls.push('parent-unmounted');
      }

      public override compose (): VirtualServiceNode[] {
        return [h(OkChild), h(FailChild)];
      }
    }

    await expect(GraphRuntime.mount(h(Parent))).rejects.toThrow(
      'FailChild: intentional mount failure',
    );

    expect(parentUnmountCalls).toEqual([]);
  });

  test('compose throw after premount clears scheduler hook on the failing instance', async () => {
    let leakedInstance: Component<Record<string, never>, Record<string, never>> | null = null;

    class BadComposeChild extends Component<Record<string, never>, Record<string, never>> {
      public override compose (): VirtualServiceNode[] {
        leakedInstance = this;
        throw new Error('BadComposeChild: compose failure');
      }
    }

    class Parent extends Component<Record<string, never>, Record<string, never>> {
      public override compose (): VirtualServiceNode[] {
        return [h(BadComposeChild)];
      }
    }

    await expect(GraphRuntime.mount(h(Parent))).rejects.toThrow(
      'BadComposeChild: compose failure',
    );

    expect(leakedInstance).not.toBeNull();
    const hook = (leakedInstance as unknown as Record<symbol, unknown>)[SCHEDULE_UPDATE_HOOK];
    expect(hook).toBeUndefined();
  });

  test('duplicate keys during materialize clear premount hook on the failing parent fiber', async () => {
    let leakedHost: Component<Record<string, never>, Record<string, never>> | null = null;

    class Leaf extends Component<Record<string, never>, { id: string }> {}

    class DupKeyHost extends Component<Record<string, never>, Record<string, never>> {
      public override compose (): VirtualServiceNode[] {
        leakedHost = this;
        return [
          h(Leaf, { id: 'a' }, 'dup'),
          h(Leaf, { id: 'b' }, 'dup'),
        ];
      }
    }

    class Root extends Component<Record<string, never>, Record<string, never>> {
      public override compose (): VirtualServiceNode[] {
        return [h(DupKeyHost)];
      }
    }

    await expect(GraphRuntime.mount(h(Root))).rejects.toThrow(/duplicate key "dup"/);

    expect(leakedHost).not.toBeNull();
    const hook = (leakedHost as unknown as Record<symbol, unknown>)[SCHEDULE_UPDATE_HOOK];
    expect(hook).toBeUndefined();
  });
});
