/**
 * Regression: if a ref setter assigns `current` then throws during materialize
 * commitRef, journal.refBound must already be true so rollback clears the zombie.
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

class Host extends Component<Record<string, never>, Record<string, never>> {
  public constructor (props: Record<string, never>) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode {
    return h(Leaf, { id: 'child' }, 'child');
  }
}

describe('GraphRuntime materialize commitRef zombie ref', () => {
  it('clears ref.current when setter assigns then throws during mount commitRef', async () => {
    Leaf.mountCount = 0;
    Leaf.unmountCount = 0;

    let stored: Host | null = null;
    const ref: RefObject<Host> = {
      get current (): Host | null {
        return stored;
      },
      set current (value: Host | null) {
        stored = value;
        if (value !== null) {
          throw new Error('ref assign-then-throw');
        }
      },
    };

    await expect(GraphRuntime.mount(h(Host, {}, ref))).rejects.toThrow(
      'ref assign-then-throw',
    );

    // Setter already wrote the instance before throwing; rollback must clear it.
    expect(stored).toBeNull();
    // Children materialize with deferLifecycle=true, so onMount has not run yet when
    // parent commitRef throws. Rollback still destroys the deferred subtree without
    // ever invoking Leaf.onMount — mount/unmount counters stay at 0.
    expect(Leaf.mountCount).toBe(0);
    expect(Leaf.unmountCount).toBe(0);
  });
});
