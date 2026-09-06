/**
 * UPDATE same-ref + @UseImperativeHandle: setter throws BEFORE storing `current`.
 *
 * resolveRefCurrentValue already replaced imperativeRefByOwner with a new handle.
 * clearRefSafe then compared ref.current (still the old handle) to the new map entry,
 * skipped clearing, but still deleted the map — fail-stop finalize could no longer
 * match and left a zombie handle in ref.current.
 */
import {
  Component,
  GraphRuntime,
  UseImperativeHandle,
  h,
} from 'Effectable';
import type { RefObject } from 'Effectable';

class Host extends Component<object, { label: string }> {
  @UseImperativeHandle()
  public ping (): string {
    return `ping:${this.props.label}`;
  }

  public override compose (): null {
    return null;
  }
}

describe('GraphRuntime UPDATE same-ref imperative throw-before-assign', () => {
  it('does not leave zombie imperative handle after setter throw-before-assign', async () => {
    let stored: unknown = null;
    let boom = false;
    const ref: RefObject<unknown> = {
      get current (): unknown {
        return stored;
      },
      set current (value: unknown) {
        if (boom && value !== null) {
          throw new Error('imperative throw-before-assign');
        }
        stored = value;
      },
    };

    const runtime = await GraphRuntime.mount(h(Host, { label: 'a' }, ref));
    expect(stored).not.toBeNull();
    const mountedHandle = stored as { ping: () => string };
    expect(mountedHandle.ping()).toBe('ping:a');

    boom = true;
    await expect(runtime.reconcile(h(Host, { label: 'b' }, ref))).rejects.toThrow(
      'imperative throw-before-assign',
    );

    expect(runtime.isActive()).toBe(false);
    expect(stored).toBeNull();

    await runtime.unmount();
  });
});
