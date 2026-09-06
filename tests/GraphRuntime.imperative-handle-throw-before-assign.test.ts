/**
 * Residual of #110: UPDATE same-ref + @UseImperativeHandle.
 *
 * resolveRefCurrentValue wrote the NEW handle into the WeakMap before assignment.
 * A custom setter that throws *before* writing `current` left ref.current on the OLD
 * handle while clearRefSafe compared against the NEW map entry, skipped the clear,
 * and deleted the map — so fail-stop / unmount could never identity-match and clear.
 */

import {
  Component,
  GraphRuntime,
  UseImperativeHandle,
  h,
} from 'Effectable';
import type { RefObject } from 'Effectable';

class Child extends Component<{ n: number }, { n: number }> {
  constructor (props: { n: number }) {
    super(props);
  }

  @UseImperativeHandle()
  public value (): number {
    return this.props.n;
  }

  public secret (): string {
    return 'SECRET';
  }
}

describe('GraphRuntime @UseImperativeHandle UPDATE throw-before-assign', () => {
  it('clears old allowlist handle when same-ref setter throws before assign', async () => {
    let stored: unknown = null;
    let calls = 0;

    const boomRef: RefObject<Child> = {
      get current (): Child | null {
        return stored as Child | null;
      },
      set current (value: Child | null) {
        calls += 1;
        // Mount succeeds; UPDATE validates then throws without writing.
        if (calls === 1) {
          stored = value;
          return;
        }
        if (value !== null) {
          throw new Error('boom before assign');
        }
        stored = value;
      },
    };

    const runtime = await GraphRuntime.mount(h(Child, { n: 1 }, boomRef));
    expect(stored).not.toBeNull();
    const mountHandle = stored as { value: () => number; secret?: () => string };
    expect(mountHandle.value()).toBe(1);
    expect(mountHandle.secret).toBeUndefined();

    await expect(runtime.reconcile(h(Child, { n: 2 }, boomRef))).rejects.toThrow(
      'boom before assign',
    );

    expect(runtime.isActive()).toBe(false);
    // Must not leave a live allowlist handle after fail-stop.
    expect(stored).toBeNull();

    await runtime.unmount();
    expect(stored).toBeNull();
  });

  it('still clears when allowlist setter assigns then throws (assign-then-throw)', async () => {
    let stored: unknown = null;
    let boom = false;

    const ref: RefObject<Child> = {
      get current (): Child | null {
        return stored as Child | null;
      },
      set current (value: Child | null) {
        stored = value;
        if (boom && value !== null) {
          throw new Error('assign-then-throw');
        }
      },
    };

    const runtime = await GraphRuntime.mount(h(Child, { n: 1 }, ref));
    expect(stored).not.toBeNull();
    boom = true;

    await expect(runtime.reconcile(h(Child, { n: 2 }, ref))).rejects.toThrow(
      'assign-then-throw',
    );

    expect(runtime.isActive()).toBe(false);
    expect(stored).toBeNull();

    await runtime.unmount();
  });
});
