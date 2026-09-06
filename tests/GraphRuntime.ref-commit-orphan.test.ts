/**
 * Regression probe: if applyFiberUpdate/commitRef throws AFTER reconcileChildren
 * succeeded (including PLACE), fail-stop only walks the old parent.children and
 * orphans newly placed fibers (onMount without onUnmount / resource leak).
 */
import { Component, GraphRuntime, h } from 'Effectable';
import type { RefObject, VirtualServiceNode } from 'Effectable';

class Leaf extends Component<{ id: string }, { id: string }> {
  public static mountCount = 0;
  public static unmountCount = 0;

  public constructor (props: { id: string }) {
    super(props);
    this.state = { id: props.id };
  }

  public override onMount (): void {
    Leaf.mountCount += 1;
  }

  public override onUnmount (): void {
    Leaf.unmountCount += 1;
  }

  public override compose (): null {
    return null;
  }
}

class Parent extends Component<Record<string, never>, { n: number }> {
  public constructor (props: { n: number }) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode[] {
    if (this.props.n === 0) {
      return [h(Leaf, { id: 'a' }, 'a')];
    }
    return [h(Leaf, { id: 'a' }, 'a'), h(Leaf, { id: 'b' }, 'b')];
  }
}

describe('GraphRuntime applyFiberUpdate ref-commit orphan', () => {
  it('PLACE child is unmounted when commitRef throws after child reconcile', async () => {
    Leaf.mountCount = 0;
    Leaf.unmountCount = 0;

    let allowBind = true;
    let stored: Parent | null = null;
    const ref: RefObject<Parent> = {
      get current (): Parent | null {
        return stored;
      },
      set current (value: Parent | null) {
        if (!allowBind && value !== null) {
          throw new Error('ref commit boom');
        }
        stored = value;
      },
    };

    const runtime = await GraphRuntime.mount(h(Parent, { n: 0 }, ref));
    expect(Leaf.mountCount).toBe(1);
    expect(Leaf.unmountCount).toBe(0);

    allowBind = false;

    await expect(runtime.reconcile(h(Parent, { n: 1 }, ref))).rejects.toThrow('ref commit boom');

    expect(runtime.isActive()).toBe(false);
    // Leaf B was PLACE'd (mountCount 2) and must not be orphaned.
    expect(Leaf.mountCount).toBe(2);
    expect(Leaf.unmountCount).toBe(2);

    await runtime.unmount();
  });
});
