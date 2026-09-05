/**
 * Regression: applyFiberUpdate commitRef throw after successful child PLACE
 * must destroy the unlinked PLACE fiber (failStop only walks the old tree).
 */
import { Component, GraphRuntime, h } from '../src/index';
import type { RefObject } from '../src/index';

describe('GraphRuntime applyFiberUpdate PLACE orphan on commitRef throw', () => {
  function throwingBindRef<T> (): { ref: RefObject<T>; arm (): void } {
    let value: T | null = null;
    let throwOnBind = false;
    return {
      arm (): void {
        throwOnBind = true;
      },
      ref: {
        get current (): T | null {
          return value;
        },
        set current (next: T | null) {
          if (throwOnBind && next !== null) {
            throw new Error('ref bind boom');
          }
          value = next;
        },
      },
    };
  }

  function throwingClearRef<T> (): RefObject<T> {
    let value: T | null = null;
    return {
      get current (): T | null {
        return value;
      },
      set current (next: T | null) {
        if (next === null && value !== null) {
          throw new Error('ref clear boom');
        }
        value = next;
      },
    };
  }

  it('same-ref re-bind throw after PLACE: PLACE child is unmounted', async () => {
    const calls: string[] = [];

    class PlaceChild extends Component {
      public override onMount (): void {
        calls.push('place:onMount');
      }

      public override onUnmount (): void {
        calls.push('place:onUnmount');
      }
    }

    class StableChild extends Component {
      public override onMount (): void {
        calls.push('stable:onMount');
      }

      public override onUnmount (): void {
        calls.push('stable:onUnmount');
      }
    }

    class Parent extends Component<Record<string, never>, { expand: boolean }> {
      public override onMount (): void {
        calls.push('parent:onMount');
      }

      public override onUnmount (): void {
        calls.push('parent:onUnmount');
      }

      public override compose () {
        if (!this.props.expand) {
          return [h(StableChild, undefined, 's')];
        }

        return [
          h(StableChild, undefined, 's'),
          h(PlaceChild, undefined, 'p'),
        ];
      }
    }

    const { ref, arm } = throwingBindRef<Parent>();
    const rt = await GraphRuntime.mount(h(Parent, { expand: false }, ref));
    expect(calls).toEqual(['stable:onMount', 'parent:onMount']);

    arm();
    await expect(
      rt.reconcile(h(Parent, { expand: true }, ref)),
    ).rejects.toThrow('ref bind boom');

    expect(calls).toContain('place:onMount');
    expect(calls).toContain('place:onUnmount');
    expect(rt.getState()).toBe('failed');
  });

  it('ref-swap clear throw after PLACE: PLACE child is unmounted', async () => {
    const calls: string[] = [];

    class PlaceChild extends Component {
      public override onMount (): void {
        calls.push('place:onMount');
      }

      public override onUnmount (): void {
        calls.push('place:onUnmount');
      }
    }

    class StableChild extends Component {
      public override onMount (): void {
        calls.push('stable:onMount');
      }

      public override onUnmount (): void {
        calls.push('stable:onUnmount');
      }
    }

    class Parent extends Component<Record<string, never>, { expand: boolean }> {
      public override onMount (): void {
        calls.push('parent:onMount');
      }

      public override onUnmount (): void {
        calls.push('parent:onUnmount');
      }

      public override compose () {
        if (!this.props.expand) {
          return [h(StableChild, undefined, 's')];
        }

        return [
          h(StableChild, undefined, 's'),
          h(PlaceChild, undefined, 'p'),
        ];
      }
    }

    const oldRef = throwingClearRef<Parent>();
    const nextRef: RefObject<Parent> = { current: null };

    const rt = await GraphRuntime.mount(h(Parent, { expand: false }, oldRef));
    expect(oldRef.current).not.toBeNull();

    await expect(
      rt.reconcile(h(Parent, { expand: true }, nextRef)),
    ).rejects.toThrow('ref clear boom');

    expect(calls).toContain('place:onMount');
    expect(calls).toContain('place:onUnmount');
    expect(nextRef.current).toBeNull();
    expect(rt.getState()).toBe('failed');
  });
});
