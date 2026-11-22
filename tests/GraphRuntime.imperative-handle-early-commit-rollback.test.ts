/**
 * Interaction of UPDATE early commitRef (#142) + @UseImperativeHandle allowlist (#110/#146).
 *
 * On child-reconcile failure after a successful early ref-swap commit, rollbackEarlyRefCommit
 * restored previousRef via resolveRefCurrentValue() WITHOUT re-registering imperativeRefByOwner.
 * fail-stop finalize then identity-mismatched and left a live allowlist handle on previousRef.
 */

import {
  Component,
  GraphRuntime,
  UseImperativeHandle,
  h,
} from 'Effectable';
import type { RefObject, VirtualServiceNode } from 'Effectable';

describe('GraphRuntime @UseImperativeHandle early UPDATE commit rollback', () => {
  it('clears previousRef allowlist handle after PLACE boom rolls back early commit', async () => {
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

    class Parent extends Component<Record<string, never>, { show: boolean; n: number }> {
      @UseImperativeHandle()
      public value (): number {
        return this.props.n;
      }

      public secret (): string {
        return 'SECRET';
      }

      public override compose (): VirtualServiceNode[] {
        return this.props.show ? [h(BoomChild, {})] : [];
      }
    }

    const runtime = await GraphRuntime.mount(
      h(Parent, { show: false, n: 1 }, refA),
    );
    expect(refA.current).not.toBeNull();
    const mountHandle = refA.current as unknown as {
      value: () => number;
      secret?: () => string;
    };
    expect(mountHandle.value()).toBe(1);
    expect(mountHandle.secret).toBeUndefined();

    await expect(
      runtime.reconcile(h(Parent, { show: true, n: 2 }, refB)),
    ).rejects.toThrow('PLACE onMount boom');

    expect(runtime.isActive()).toBe(false);
    expect(refB.current).toBeNull();
    // Critical: previousRef must not retain a live allowlist handle after fail-stop.
    expect(refA.current).toBeNull();

    await runtime.unmount();
    expect(refA.current).toBeNull();
  });
});
