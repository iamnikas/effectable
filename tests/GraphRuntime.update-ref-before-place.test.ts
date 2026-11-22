/**
 * Regression: UPDATE deferred parent commitRef until after child reconcile, so a
 * same-pass PLACE child's onMount saw nextRef.current === null (mount path already
 * commits before deferred onMount flush).
 *
 * Also covers rollback: if child reconcile fails after the early commit, nextRef
 * must not remain a zombie while fiber.vnode.ref still names previousRef.
 */
import { Component, GraphRuntime, h } from 'Effectable';
import type { RefObject, VirtualServiceNode } from 'Effectable';

describe('GraphRuntime UPDATE parent ref before PLACE onMount', () => {
  it('PLACE child onMount sees swapped parent ref.current (same reconcile)', async () => {
    const seen: Array<unknown> = [];
    const refA: RefObject<Parent> = { current: null };
    const refB: RefObject<Parent> = { current: null };

    class Child extends Component<Record<string, never>, { parentRef: RefObject<Parent> }> {
      public override onMount (): void {
        seen.push(this.props.parentRef.current);
      }

      public override compose (): null {
        return null;
      }
    }

    class Parent extends Component<
      Record<string, never>,
      { show: boolean; parentRef: RefObject<Parent> }
    > {
      public override compose (): VirtualServiceNode[] {
        return this.props.show
          ? [h(Child, { parentRef: this.props.parentRef })]
          : [];
      }
    }

    const runtime = await GraphRuntime.mount(
      h(Parent, { show: false, parentRef: refA }, refA),
    );
    expect(refA.current).toBeInstanceOf(Parent);
    expect(refB.current).toBeNull();

    await runtime.reconcile(h(Parent, { show: true, parentRef: refB }, refB));
    expect(runtime.isActive()).toBe(true);
    expect(refB.current).toBeInstanceOf(Parent);
    expect(seen[0]).toBe(refB.current);

    await runtime.unmount();
  });

  it('rolls back nextRef when PLACE onMount throws after early UPDATE commitRef', async () => {
    const refA: RefObject<Parent> = { current: null };
    const refB: RefObject<Parent> = { current: null };

    class BoomChild extends Component<Record<string, never>, Record<string, never>> {
      public override onMount (): void {
        throw new Error('PLACE onMount boom');
      }

      public override compose (): null {
        return null;
      }
    }

    class Parent extends Component<Record<string, never>, { show: boolean }> {
      public override compose (): VirtualServiceNode[] {
        return this.props.show ? [h(BoomChild, {})] : [];
      }
    }

    const runtime = await GraphRuntime.mount(h(Parent, { show: false }, refA));
    expect(refA.current).toBeInstanceOf(Parent);

    await expect(
      runtime.reconcile(h(Parent, { show: true }, refB)),
    ).rejects.toThrow('PLACE onMount boom');

    expect(runtime.isActive()).toBe(false);
    // Early commit bound refB; rollback + fail-stop must clear both.
    expect(refA.current).toBeNull();
    expect(refB.current).toBeNull();

    await runtime.unmount();
  });
});
