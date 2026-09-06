/**
 * Regression: `autoRegister` reuses the instance `@UseRef` object across remounts.
 * Disposers that only compared handle identity treated the remount registration as
 * "still theirs" and deleted the live handle — breaking resolve after remount.
 */
import {
  HandleRegistry,
  HandleRegistryUseImperativeHandle,
  HandleRegistryUseRef,
  forwardRef,
} from 'Effectable';

@forwardRef('svc')
class Host {
  @HandleRegistryUseRef()
  public ref: Record<string, unknown> = {};

  @HandleRegistryUseImperativeHandle()
  public ping (): string {
    return 'ok';
  }
}

describe('HandleRegistry autoRegister remount disposer', () => {
  it('stale disposer after second autoRegister must not drop the live handle', () => {
    const registry = new HandleRegistry();
    const host = new Host();
    const d1 = registry.autoRegister(host);
    const d2 = registry.autoRegister(host);

    expect(registry.has('svc')).toBe(true);
    expect(registry.resolve('svc')).toBe(host.ref);

    d1();

    expect(registry.has('svc')).toBe(true);
    expect(registry.resolve('svc')).toBe(host.ref);
    expect(typeof (registry.resolve('svc') as { ping?: () => string }).ping).toBe(
      'function',
    );

    d2();
    expect(registry.has('svc')).toBe(false);
  });

  it('register with the same handle object twice is generation-safe', () => {
    const registry = new HandleRegistry();
    const handle = { id: 1 };
    const d1 = registry.register('k', handle);
    const d2 = registry.register('k', handle);

    d1();
    expect(registry.has('k')).toBe(true);
    expect(registry.resolve('k')).toBe(handle);

    d2();
    expect(registry.has('k')).toBe(false);
  });
});
