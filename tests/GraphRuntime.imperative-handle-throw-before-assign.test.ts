/**
 * Regression: UPDATE same-ref commitRef must not drop imperativeRefByOwner before
 * assignment succeeds. A setter that throws before storing the new handle used to
 * leave ref.current holding the previous handle while the owner map was cleared,
 * so fail-stop finalize could not identity-match and left a zombie imperative API.
 *
 * Distinct from #103 (ref-swap assign-then-throw) and #110 (allowlist).
 */

import {
  Component,
  GraphRuntime,
  UseImperativeHandle,
  UseRef,
  h,
} from 'Effectable';
import type { RefObject } from 'Effectable';

describe('GraphRuntime @UseImperativeHandle UPDATE throw-before-assign', () => {
  class Child extends Component<Record<string, unknown>, Record<string, unknown>> {
    constructor () {
      super({});
    }

    @UseImperativeHandle()
    public ping (): string {
      return 'pong';
    }
  }

  class Parent extends Component<{ boom: boolean }, { boom: boolean }> {
    @UseRef()
    public declare childRef: RefObject<Child>;

    constructor (props: { boom: boolean }) {
      super(props);
    }

    public override compose () {
      if (this.props.boom) {
        const ref = this.childRef as RefObject<unknown>;
        let stored: unknown = ref.current;
        Object.defineProperty(ref, 'current', {
          configurable: true,
          enumerable: true,
          get: () => stored,
          set: (v: unknown) => {
            // Throw before assign for non-null updates only — allow cleanup null.
            if (v !== null) {
              throw new Error('setter boom before assign');
            }
            stored = v;
          },
        });
      }
      return [h(Child, {}, this.childRef)];
    }
  }

  it('same-ref UPDATE throw-before-assign clears handle after fail-stop', async () => {
    const runtime = await GraphRuntime.mount(h(Parent, { boom: false }));
    const parent = runtime.getRootInstance() as Parent;
    const before = parent.childRef.current;
    expect(before).not.toBeNull();
    expect(typeof (before as unknown as { ping: () => string }).ping).toBe('function');

    await expect(runtime.reconcile(h(Parent, { boom: true }))).rejects.toThrow(/setter boom/);

    expect(parent.childRef.current).toBeNull();
  });
});
