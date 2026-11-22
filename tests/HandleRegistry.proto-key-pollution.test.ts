/**
 * Regression: HandleRegistry.buildRefHandle must not treat a method named
 * `__proto__` as the Object.prototype setter when filling `@UseRef` objects.
 *
 * Ordinary `ref[methodName] = bound` replaces the handle's [[Prototype]] with
 * the bound function, drops the own key, and breaks resolve()/call sites.
 *
 * @module Effectable/runtime/HandleRegistry.proto-key-pollution.test
 */

import {
  HandleRegistry,
  HandleRegistryUseImperativeHandle,
  HandleRegistryUseRef,
  forwardRef,
} from 'Effectable';

@forwardRef('proto-handle-key')
class ProtoNamedMethodHost {
  @HandleRegistryUseRef()
  public handle: Record<string, unknown> = {};

  @HandleRegistryUseImperativeHandle()
  public ['__proto__'] (): string {
    return 'from-proto-method';
  }

  @HandleRegistryUseImperativeHandle()
  public ping (): string {
    return 'pong';
  }
}

describe('HandleRegistry __proto__ key assignment safety', () => {
  it('keeps __proto__ as an own handle method without polluting [[Prototype]]', () => {
    const registry = new HandleRegistry();
    const host = new ProtoNamedMethodHost();
    const dispose = registry.autoRegister(host);

    expect(Object.getPrototypeOf(host.handle)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(host.handle, '__proto__')).toBe(true);
    expect(Object.keys(host.handle).sort()).toEqual(['__proto__', 'ping'].sort());

    const handle = registry.resolve<{
      ping: () => string;
      __proto__: () => string;
    }>('proto-handle-key');

    expect(handle.ping()).toBe('pong');
    expect(typeof handle['__proto__']).toBe('function');
    expect(handle['__proto__']()).toBe('from-proto-method');
    // Must not inherit phantom fields from a polluted prototype function.
    expect((host.handle as { name?: string }).name).toBeUndefined();

    dispose();
  });
});
