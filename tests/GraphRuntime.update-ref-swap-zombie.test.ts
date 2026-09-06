/**
 * UPDATE ref-swap: nextRef setter assigns instance then throws.
 * fail-stop finalize only clears fiber.vnode.ref (still the previous ref object),
 * so nextRef would retain a zombie instance unless commitRef clears on throw.
 */
import { Component, GraphRuntime, h } from 'Effectable';
import type { RefObject } from 'Effectable';

class Host extends Component<object, { label: string }> {
  public override compose (): null {
    return null;
  }
}

describe('GraphRuntime UPDATE commitRef assign-then-throw on ref swap', () => {
  it('clears nextRef when setter assigns then throws (no zombie after fail-stop)', async () => {
    let storedA: Host | null = null;
    const refA: RefObject<Host> = {
      get current (): Host | null {
        return storedA;
      },
      set current (value: Host | null) {
        storedA = value;
      },
    };

    let storedB: Host | null = null;
    const refB: RefObject<Host> = {
      get current (): Host | null {
        return storedB;
      },
      set current (value: Host | null) {
        storedB = value;
        if (value !== null) {
          throw new Error('nextRef assign-then-throw');
        }
      },
    };

    const runtime = await GraphRuntime.mount(h(Host, { label: 'a' }, refA));
    expect(storedA).not.toBeNull();

    await expect(runtime.reconcile(h(Host, { label: 'b' }, refB))).rejects.toThrow(
      'nextRef assign-then-throw',
    );

    expect(runtime.isActive()).toBe(false);
    expect(storedA).toBeNull();
    expect(storedB).toBeNull();

    await runtime.unmount();
  });

  it('same-ref UPDATE assign-then-throw still clears via fail-stop finalize', async () => {
    let stored: Host | null = null;
    let boom = false;
    const ref: RefObject<Host> = {
      get current (): Host | null {
        return stored;
      },
      set current (value: Host | null) {
        stored = value;
        if (boom && value !== null) {
          throw new Error('same-ref boom');
        }
      },
    };

    const runtime = await GraphRuntime.mount(h(Host, { label: 'a' }, ref));
    expect(stored).not.toBeNull();
    boom = true;

    await expect(runtime.reconcile(h(Host, { label: 'b' }, ref))).rejects.toThrow('same-ref boom');
    expect(runtime.isActive()).toBe(false);
    expect(stored).toBeNull();

    await runtime.unmount();
  });
});
