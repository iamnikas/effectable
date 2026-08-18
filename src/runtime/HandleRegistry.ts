/**
 * Registry of imperative handle objects.
 *
 * `HandleRegistry` is a small runtime registry that stores and retrieves
 * "imperative handles" (objects with methods) keyed by a string.
 *
 * In application code this idea is used for bridge mechanics:
 * 1) a runtime-host/internal service creates a handle (for example with `runUname()` / `getSnapshot()`),
 * 2) that handle is registered in `HandleRegistry` under a `handleKey`,
 * 3) command/query handlers obtain the handle via `resolve()` and call its methods.
 *
 * Thanks to this, domain handlers do not depend on how the runtime-host lifecycle is structured:
 * they only operate on `key -> handle -> method`.
 *
 * @module Effectable/runtime/HandleRegistry
 *
 * @example
 * const handleRegistry = new HandleRegistry();
 *
 * // runtime-host created an imperative handle and registered it
 * const disposer = handleRegistry.register('domain:instance1:handle', myHandle);
 *
 * // query-handler resolves the handle by key and returns a snapshot
 * const handle = handleRegistry.resolve<typeof myHandle>('domain:instance1:handle');
 * const snapshot = handle.getSnapshot();
 *
 * // on shutdown the runtime-host must unregister
 * disposer();
 */

import 'reflect-metadata';

const USE_REF_METADATA_KEY = 'effectable:HandleRegistry:UseRef';
const USE_REF_PROPERTY_METADATA_KEY = 'effectable:HandleRegistry:UseRefProperty';
const USE_IMPERATIVE_HANDLE_METADATA_KEY = 'effectable:HandleRegistry:UseImperativeHandle';

export type HandleRefKeyFactory<TInstance = unknown> =
  | string
  | ((instance: TInstance) => string);

/**
 * Decorator that sets a handle key (or key factory) for an instance.
 *
 * Used together with `HandleRegistry.autoRegister(instance)`:
 * - the decorator stores key metadata
 * - `autoRegister()` fills the ref object (on the field marked with `@UseRef()`)
 *   with methods marked with `@UseImperativeHandle()`
 */
export function forwardRef<TInstance = unknown> (
  keyOrFactory: HandleRefKeyFactory<TInstance>
): ClassDecorator {
  return (target) => {
    Reflect.defineMetadata(USE_REF_METADATA_KEY, keyOrFactory, target);
  };
}

/**
 * Method decorator that includes a method in the imperative handle.
 *
 * Together with `@forwardRef(...)` and the `@UseRef()` property decorator, it lets you build a handle
 * without manually calling `handleRegistry.register(handleKey, { ... })`.
 */
export function UseImperativeHandle (): MethodDecorator {
  return (target, propertyKey) => {
    if (typeof propertyKey === 'undefined') {
      return;
    }

    const ctor = target.constructor;
    const current = Reflect.getOwnMetadata(
      USE_IMPERATIVE_HANDLE_METADATA_KEY,
      ctor
    ) as Set<string> | undefined;

    const next = typeof current === 'undefined'
      ? new Set<string>()
      : new Set<string>(current);

    next.add(String(propertyKey));
    Reflect.defineMetadata(USE_IMPERATIVE_HANDLE_METADATA_KEY, next, ctor);
  };
}

/**
 * Property decorator that marks the field where the runtime host should place a ref object.
 *
 * That ref object is then filled with methods marked with `@UseImperativeHandle()`.
 */
export function UseRef (): PropertyDecorator {
  return (target, propertyKey) => {
    if (typeof propertyKey === 'undefined') {
      return;
    }

    const ctor = target.constructor;
    Reflect.defineMetadata(USE_REF_PROPERTY_METADATA_KEY, propertyKey, ctor);
  };
}

/**
 * Handle registry keyed by string.
 */
export class HandleRegistry {
  private readonly handles = new Map<string, unknown>();

  private getInheritedMetadata<T> (ctor: Function, metaKey: string): T | undefined {
    let current: Function | null = ctor;
    while (current != null && typeof current === 'function') {
      const value = Reflect.getOwnMetadata(metaKey, current) as T | undefined;
      if (value !== undefined) {
        return value;
      }
      const next = Object.getPrototypeOf(current);
      if (typeof next !== 'function' || next === null) {
        break;
      }
      current = next;
    }
    return undefined;
  }

  private buildRefHandle (instance: unknown): unknown {
    const ctor = instance !== null && typeof instance === 'object'
      ? (instance as { constructor: Function }).constructor
      : null;
    if (typeof ctor !== 'function') {
      throw new Error('HandleRegistry.autoRegister: invalid instance');
    }

    const refPropertyKey = this.getInheritedMetadata<string>(ctor, USE_REF_PROPERTY_METADATA_KEY);

    if (typeof refPropertyKey === 'undefined') {
      throw new Error('HandleRegistry.autoRegister: missing ref property metadata (@UseRef)');
    }

    const ref = (instance as Record<string, unknown>)[refPropertyKey];
    if (typeof ref !== 'object' || ref === null) {
      throw new Error('HandleRegistry.autoRegister: ref property is not an object');
    }

    const methodNames = new Set<string>();
    let current: Function | null = ctor;
    while (current != null && typeof current === 'function') {
      const ownMethods = Reflect.getOwnMetadata(
        USE_IMPERATIVE_HANDLE_METADATA_KEY,
        current
      ) as Set<string> | undefined;
      if (ownMethods !== undefined) {
        for (const methodName of ownMethods) {
          methodNames.add(methodName);
        }
      }
      const next = Object.getPrototypeOf(current);
      if (typeof next !== 'function' || next === null) {
        break;
      }
      current = next;
    }

    if (methodNames.size === 0) {
      throw new Error('HandleRegistry.autoRegister: no @UseImperativeHandle methods');
    }

    for (const methodName of methodNames) {
      const fn = (instance as Record<string, unknown>)[methodName];
      if (typeof fn !== 'function') {
        throw new Error(`HandleRegistry.autoRegister: method is not a function: ${methodName}`);
      }

      (ref as Record<string, unknown>)[methodName] = fn.bind(instance);
    }

    return ref;
  }

  private resolveHandleKey (instance: unknown): string {
    const ctor = instance !== null && typeof instance === 'object'
      ? (instance as { constructor: Function }).constructor
      : null;
    if (typeof ctor !== 'function') {
      throw new Error('HandleRegistry.autoRegister: invalid instance');
    }

    const keyOrFactory = this.getInheritedMetadata<HandleRefKeyFactory<unknown>>(
      ctor,
      USE_REF_METADATA_KEY
    );

    if (typeof keyOrFactory === 'undefined') {
      throw new Error('HandleRegistry.autoRegister: missing @UseRef metadata');
    }

    if (typeof keyOrFactory === 'string') {
      return keyOrFactory;
    }

    return keyOrFactory(instance);
  }

  /**
   * Automatically registers an imperative handle for the given instance.
   *
   * `instance` must be annotated with:
   * - `@UseRef(...)` on the class (sets the handle key)
   * - `@UseImperativeHandle()` on methods (defines the handle surface)
   *
   * @param {unknown} instance - instance from which the handle is built
   * @returns {() => void} disposer that unregisters the handle
   */
  public autoRegister (instance: unknown): () => void {
    const key = this.resolveHandleKey(instance);
    const handle = this.buildRefHandle(instance);
    return this.register(key, handle);
  }

  /**
   * Registers a handle and returns a disposer that unregisters it.
   *
   * Prefer keeping the disposer and calling it from the component's `onUnmount()`,
   * so stale handles are not left after the runtime instance stops.
   *
   * @param {string} key - handle key
   * @param {THandle} handle - imperative API object
   * @returns {() => void} unregister function
   */
  public register<THandle> (key: string, handle: THandle): () => void {
    this.handles.set(key, handle);
    return () => {
      this.unregister(key);
    };
  }

  /**
   * Removes a handle by key.
   *
   * Usually called either directly in "manual lifecycle" scenarios,
   * or indirectly via the disposer returned from `register()`.
   *
   * @param {string} key - handle key
   * @returns {void}
   */
  public unregister (key: string): void {
    this.handles.delete(key);
  }

  /**
   * Returns a handle by key if it is registered.
   *
   * If the handle is not found, returns `undefined` — without throwing.
   *
   * @param {string} key - handle key
   * @returns {THandle | undefined} found handle
   */
  public get<THandle> (key: string): THandle | undefined {
    return this.handles.get(key) as THandle | undefined;
  }

  /**
   * Returns a handle by key or throws.
   *
   * This is the strict method: suitable for command/query handlers
   * when a missing handle means a business-logic error
   * (for example, a request arrived for an instance that has already stopped).
   *
   * @param {string} key - handle key
   * @returns {THandle} found handle
   * @throws {Error} if the handle is not registered
   */
  public resolve<THandle> (key: string): THandle {
    const handle = this.get<THandle>(key);
    if (typeof handle === 'undefined') {
      throw new Error(`Handle is not registered: ${key}`);
    }
    return handle;
  }

  /**
   * Checks whether a handle exists for the key.
   *
   * Useful for diagnostics and "soft" scenarios
   * when you want to avoid exceptions and take an alternate path.
   *
   * @param {string} key - handle key
   * @returns {boolean} true if the handle is registered
   */
  public has (key: string): boolean {
    return this.handles.has(key);
  }

  /**
   * Returns the list of registered keys.
   *
   * Suitable for debugging runtime instances (for example, to see
   * which handles are currently active).
   *
   * @returns {string[]} list of keys
   */
  public keys (): string[] {
    return Array.from(this.handles.keys());
  }

  /**
   * Fully clears the registry.
   *
   * Use on full system/subsystem shutdown,
   * when all previously registered imperative handles are considered obsolete.
   *
   * @returns {void}
   */
  public clear (): void {
    this.handles.clear();
  }
}
