/**
 * Critical: materialize sets journal.refBound only after commitRef returns.
 * A ref.current setter that assigns then throws leaves the caller holding a
 * never-started instance; rollback skips clear because refBound is still false.
 */
import { Component, GraphRuntime, h } from 'Effectable';
import type { RefObject, VirtualServiceNode } from 'Effectable';

describe('GraphRuntime commitRef assign-then-throw zombie ref', () => {
  it('clears caller ref when ref setter assigns then throws during mount', async () => {
    let stored: Host | null = null;
    const mountCounts = { host: 0, leaf: 0 };
    const unmountCounts = { host: 0, leaf: 0 };

    class Leaf extends Component<Record<string, never>, Record<string, never>> {
      public override onMount (): void {
        mountCounts.leaf += 1;
      }

      public override onUnmount (): void {
        unmountCounts.leaf += 1;
      }
    }

    class Host extends Component<Record<string, never>, Record<string, never>> {
      public override onMount (): void {
        mountCounts.host += 1;
      }

      public override onUnmount (): void {
        unmountCounts.host += 1;
      }

      public override compose (): VirtualServiceNode[] {
        return [h(Leaf)];
      }
    }

    const ref: RefObject<Host | null> = {
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

    await expect(GraphRuntime.mount(h(Host, {}, ref as RefObject<Host>))).rejects.toThrow(
      'ref assign-then-throw'
    );

    expect(stored).toBeNull();
    expect(mountCounts.host).toBe(0);
    expect(unmountCounts.leaf).toBe(mountCounts.leaf);
    expect(mountCounts.leaf).toBeGreaterThanOrEqual(1);
  });
});
