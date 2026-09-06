/**
 * Regression: `@UseImperativeHandle` method named `__proto__` must become an own
 * property on the ref handle — not invoke Object.prototype's `__proto__` setter
 * (which replaces the handle [[Prototype]] with the bound function).
 *
 * Sibling of store/connect #109 and Component/BusDecorators #135; those PRs do not
 * cover HandleRegistry.buildRefHandle.
 */
import {
  HandleRegistry,
  HandleRegistryUseImperativeHandle,
  HandleRegistryUseRef,
  forwardRef,
} from 'Effectable';

@forwardRef('proto-handle')
class ProtoMethodHost {
  @HandleRegistryUseRef()
  public ref: Record<string, unknown> = {};

  @HandleRegistryUseImperativeHandle()
  public ['__proto__'] (): string {
    return 'from-proto-method';
  }

  @HandleRegistryUseImperativeHandle()
  public ping (): string {
    return 'pong';
  }
}

describe('HandleRegistry __proto__ method assignment safety', () => {
  it('autoRegister: __proto__ method stays an own handle field (no prototype pollution)', () => {
    const registry = new HandleRegistry();
    const host = new ProtoMethodHost();

    const dispose = registry.autoRegister(host);

    expect(Object.getPrototypeOf(host.ref)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(host.ref, '__proto__')).toBe(true);
    expect(typeof host.ref['__proto__']).toBe('function');
    expect((host.ref['__proto__'] as () => string)()).toBe('from-proto-method');

    // Sibling methods still land as own enumerable fields on a healthy Object.
    expect(typeof host.ref.ping).toBe('function');
    expect((host.ref.ping as () => string)()).toBe('pong');

    const resolved = registry.resolve<Record<string, unknown>>('proto-handle');
    expect(resolved).toBe(host.ref);
    expect(Object.getPrototypeOf(resolved)).toBe(Object.prototype);

    dispose();
  });
});
