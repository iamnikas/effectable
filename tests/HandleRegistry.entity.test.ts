/**
 * Entity tests for HandleRegistry (N09–N10).
 *
 * @module Effectable/runtime/HandleRegistry.entity.test
 */

import {
  HandleRegistry,
  HandleRegistryUseImperativeHandle,
  HandleRegistryUseRef,
  forwardRef,
} from 'Effectable';

interface CounterHandle {
  inc: () => number;
  read: () => number;
}

@forwardRef('static-handle-key')
class StaticKeyHost {
  @HandleRegistryUseRef()
  public handle: Record<string, unknown> = {};

  private value = 10;

  @HandleRegistryUseImperativeHandle()
  public inc (): number {
    this.value += 1;
    return this.value;
  }

  @HandleRegistryUseImperativeHandle()
  public read (): number {
    return this.value;
  }
}

@forwardRef<DynamicKeyHost>((instance) => {
  return instance.key;
})
class DynamicKeyHost {
  @HandleRegistryUseRef()
  public handle: Record<string, unknown> = {};

  public readonly key: string;

  constructor (key: string) {
    this.key = key;
  }

  @HandleRegistryUseImperativeHandle()
  public ping (): string {
    return `pong:${this.key}`;
  }
}

describe('HandleRegistry', () => {
  it('N09: register, get, resolve and disposer remove the handle', () => {
    const registry = new HandleRegistry();
    const handle: CounterHandle = {
      inc: () => 1,
      read: () => 0,
    };

    const dispose = registry.register('k1', handle);
    expect(registry.has('k1')).toBe(true);
    expect(registry.get<CounterHandle>('k1')).toBe(handle);
    expect(registry.resolve<CounterHandle>('k1')).toBe(handle);

    dispose();
    expect(registry.get('k1')).toBeUndefined();
    expect(registry.has('k1')).toBe(false);
  });

  it('N09: resolve without handle throws, get returns undefined', () => {
    const registry = new HandleRegistry();
    expect(registry.get('missing')).toBeUndefined();
    expect(() => {
      registry.resolve('missing');
    }).toThrow('Handle is not registered: missing');
  });

  it('N09: repeated register overwrites the handle without throwing', () => {
    const registry = new HandleRegistry();
    registry.register('dup', { v: 1 });
    registry.register('dup', { v: 2 });
    expect(registry.get<{ v: number }>('dup')).toEqual({ v: 2 });
  });

  it('N10: autoRegister with static forwardRef and UseRef / UseImperativeHandle', () => {
    const registry = new HandleRegistry();
    const host = new StaticKeyHost();
    const dispose = registry.autoRegister(host);

    const handle = registry.resolve<CounterHandle>('static-handle-key');
    expect(handle.read()).toBe(10);
    expect(handle.inc()).toBe(11);
    expect(handle.read()).toBe(11);

    dispose();
    expect(registry.get('static-handle-key')).toBeUndefined();
  });

  it('N10: autoRegister with factory forwardRef', () => {
    const registry = new HandleRegistry();
    const host = new DynamicKeyHost('dyn-42');
    registry.autoRegister(host);

    const handle = registry.resolve<{ ping: () => string }>('dyn-42');
    expect(handle.ping()).toBe('pong:dyn-42');
  });

  it('double dispose of registration is safe', () => {
    const registry = new HandleRegistry();
    const dispose = registry.register('safe', { ok: true });
    dispose();
    expect(() => {
      dispose();
    }).not.toThrow();
    expect(registry.get('safe')).toBeUndefined();
  });

  it('HR-07: keys() returns all registered keys', () => {
    const registry = new HandleRegistry();
    expect(registry.keys()).toEqual([]);

    registry.register('alpha', { v: 1 });
    registry.register('beta', { v: 2 });
    registry.register('gamma', { v: 3 });

    expect(registry.keys().sort()).toEqual(['alpha', 'beta', 'gamma']);

    registry.unregister('beta');
    expect(registry.keys().sort()).toEqual(['alpha', 'gamma']);
  });

  it('HR-09: unregister(key) removes the handle directly without disposer', () => {
    const registry = new HandleRegistry();
    registry.register('direct-unreg', { ok: true });
    expect(registry.has('direct-unreg')).toBe(true);

    registry.unregister('direct-unreg');
    expect(registry.has('direct-unreg')).toBe(false);
    expect(registry.get('direct-unreg')).toBeUndefined();
    expect(() => {
      registry.resolve('direct-unreg');
    }).toThrow('Handle is not registered: direct-unreg');
  });

  it('HR-12: autoRegister throws when ref property is not an object', () => {
    @forwardRef('bad-ref-type-key')
    class BadRefTypeHost {
      @HandleRegistryUseRef()
      public handle: unknown = 'not-an-object';

      @HandleRegistryUseImperativeHandle()
      public ping (): string {
        return 'pong';
      }
    }

    const registry = new HandleRegistry();
    expect(() => {
      registry.autoRegister(new BadRefTypeHost());
    }).toThrow('HandleRegistry.autoRegister: ref property is not an object');
  });

  it('HR-08: clear() removes all registered handles', () => {
    const registry = new HandleRegistry();
    registry.register('a', { v: 1 });
    registry.register('b', { v: 2 });
    expect(registry.keys().sort()).toEqual(['a', 'b']);

    registry.clear();
    expect(registry.keys()).toEqual([]);
    expect(registry.get('a')).toBeUndefined();
    expect(registry.get('b')).toBeUndefined();
    expect(registry.has('a')).toBe(false);
  });

  it('stale handle disposer after replacement does not delete the newer handle', () => {
    const registry = new HandleRegistry();
    const handleA = { id: 'A' };
    const handleB = { id: 'B' };

    const disposeA = registry.register('x', handleA);
    registry.register('x', handleB);

    disposeA();

    expect(registry.get('x')).toBe(handleB);
    expect(registry.has('x')).toBe(true);
  });

  it('disposal after registry clear does not delete a later re-registration', () => {
    const registry = new HandleRegistry();
    const handleA = { id: 'A' };
    const handleB = { id: 'B' };

    const disposeA = registry.register('x', handleA);
    registry.clear();
    registry.register('x', handleB);

    disposeA();

    expect(registry.get('x')).toBe(handleB);
  });

  it('repeated disposal is a no-op and does not remove a replacement', () => {
    const registry = new HandleRegistry();
    const handleA = { id: 'A' };
    const handleB = { id: 'B' };

    const disposeA = registry.register('x', handleA);
    disposeA();
    expect(registry.get('x')).toBeUndefined();

    registry.register('x', handleB);
    disposeA();
    disposeA();

    expect(registry.get('x')).toBe(handleB);
  });

  it('HR-10: autoRegister on an invalid instance throws', () => {
    const registry = new HandleRegistry();
    expect(() => {
      registry.autoRegister(null);
    }).toThrow('HandleRegistry.autoRegister: invalid instance');
    expect(() => {
      registry.autoRegister('not-an-object');
    }).toThrow('HandleRegistry.autoRegister: invalid instance');
  });

  it('HR-11: autoRegister without @UseRef on the field throws', () => {
    @forwardRef('no-use-ref-key')
    class MissingUseRefHost {
      public handle: Record<string, unknown> = {};

      @HandleRegistryUseImperativeHandle()
      public ping (): string {
        return 'pong';
      }
    }

    const registry = new HandleRegistry();
    expect(() => {
      registry.autoRegister(new MissingUseRefHost());
    }).toThrow('HandleRegistry.autoRegister: missing ref property metadata (@UseRef)');
  });

  it('HR-13: autoRegister without @UseImperativeHandle throws', () => {
    @forwardRef('no-imperative-key')
    class MissingImperativeHost {
      @HandleRegistryUseRef()
      public handle: Record<string, unknown> = {};

      public ping (): string {
        return 'pong';
      }
    }

    const registry = new HandleRegistry();
    expect(() => {
      registry.autoRegister(new MissingImperativeHost());
    }).toThrow('HandleRegistry.autoRegister: no @UseImperativeHandle methods');
  });

  it('HR-15: autoRegister without @forwardRef throws', () => {
    class MissingForwardRefHost {
      @HandleRegistryUseRef()
      public handle: Record<string, unknown> = {};

      @HandleRegistryUseImperativeHandle()
      public ping (): string {
        return 'pong';
      }
    }

    const registry = new HandleRegistry();
    expect(() => {
      registry.autoRegister(new MissingForwardRefHost());
    }).toThrow('HandleRegistry.autoRegister: missing @UseRef metadata');
  });
});
