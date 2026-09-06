/**
 * UPDATE same RefObject + @UseImperativeHandle: setter throws *before* assigning.
 *
 * resolveRefCurrentValue replaces imperativeRefByOwner with a new handle object before
 * the setter runs. clearRefSafe on catch only identity-matches that new handle, deletes
 * the map entry, and leaves ref.current on the previous handle — fail-stop finalize can
 * no longer clear → zombie imperative handle after destroy.
 *
 * Distinct from #103 (assign-then-throw / ref swap) and #110 (allowlist surface).
 */
import {
  Component,
  GraphRuntime,
  UseImperativeHandle,
  h,
} from 'Effectable';
import type { RefObject } from 'Effectable';

type ChildHandle = { ping: () => string };

class Child extends Component<object, { n: number }> {
  public constructor (props: { n: number }) {
    super(props);
  }

  @UseImperativeHandle()
  public ping (): string {
    return `p${this.props.n}`;
  }

  public override compose (): null {
    return null;
  }
}

class Parent extends Component<object, { n: number; childRef: RefObject<Child> }> {
  public constructor (props: { n: number; childRef: RefObject<Child> }) {
    super(props);
  }

  public override compose (): ReturnType<typeof h>[] {
    return [h(Child, { n: this.props.n }, this.props.childRef)];
  }
}

describe('GraphRuntime @UseImperativeHandle throw-before-assign zombie', () => {
  it('same-ref UPDATE throw-before-assign must clear previous handle on fail-stop', async () => {
    let stored: ChildHandle | null = null;
    let throwBeforeAssign = false;
    const ref: RefObject<Child> = {
      get current (): Child | null {
        return stored as unknown as Child | null;
      },
      set current (value: Child | null) {
        if (throwBeforeAssign && value !== null) {
          throw new Error('throw-before-assign');
        }
        stored = value as unknown as ChildHandle | null;
      },
    };

    const runtime = await GraphRuntime.mount(h(Parent, { n: 1, childRef: ref }));
    expect(stored).not.toBeNull();
    expect(stored!.ping()).toBe('p1');

    throwBeforeAssign = true;
    await expect(
      runtime.reconcile(h(Parent, { n: 2, childRef: ref })),
    ).rejects.toThrow('throw-before-assign');

    expect(runtime.isActive()).toBe(false);
    expect(stored).toBeNull();

    await runtime.unmount();
  });
});
