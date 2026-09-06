/**
 * Residual of early UPDATE commitRef (before child reconcile / PLACE onMount):
 * root onUpdate runs *after* that early commit but *before* applyFiberUpdate
 * publishes nextRef onto fiber.vnode.ref. If onUpdate throws, fail-stop only
 * clears fiber.vnode.ref (still previousRef) unless we roll the early commit
 * back — otherwise nextRef retains a torn-down instance (zombie / UAF).
 */
import { Component, GraphRuntime, h } from 'Effectable';
import type { RefObject } from 'Effectable';

class Host extends Component<object, { label: string }> {
  public override onUpdate (): void {
    throw new Error('onUpdate boom');
  }

  public override compose (): null {
    return null;
  }
}

describe('GraphRuntime UPDATE early commitRef + onUpdate throw', () => {
  it('rolls back nextRef when root onUpdate throws after early commitRef', async () => {
    const refA: RefObject<Host> = { current: null };
    const refB: RefObject<Host> = { current: null };

    const runtime = await GraphRuntime.mount(h(Host, { label: 'a' }, refA));
    expect(refA.current).toBeInstanceOf(Host);
    expect(refB.current).toBeNull();

    await expect(runtime.reconcile(h(Host, { label: 'b' }, refB))).rejects.toThrow(
      'onUpdate boom',
    );

    expect(runtime.isActive()).toBe(false);
    expect(refA.current).toBeNull();
    expect(refB.current).toBeNull();

    await runtime.unmount();
  });

  it('same-ref UPDATE onUpdate throw still clears via fail-stop finalize', async () => {
    const ref: RefObject<Host> = { current: null };

    const runtime = await GraphRuntime.mount(h(Host, { label: 'a' }, ref));
    expect(ref.current).toBeInstanceOf(Host);

    await expect(runtime.reconcile(h(Host, { label: 'b' }, ref))).rejects.toThrow(
      'onUpdate boom',
    );

    expect(runtime.isActive()).toBe(false);
    expect(ref.current).toBeNull();

    await runtime.unmount();
  });
});
