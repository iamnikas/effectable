/**
 * Ref machinery for declarative component composition in GraphRuntime.
 *
 * - {@link UseRef} — property decorator: lazily creates a `RefObject` and registers the field for runtime binding.
 * - {@link UseImperativeHandle} — method decorator: marks a method as part of the child node's public imperative API.
 *
 * **Ref usage rules**
 *
 * - Ref is a controlled escape hatch; do not use it as a service locator.
 * - Only for a narrow imperative API (e.g. reset, focus, flush).
 * - Does not replace DI, CommandBus, or context.
 * - After the node unmounts, GraphRuntime clears `ref.current`.
 *
 * @module Effectable/component/refs
 */

import type { RefObject } from './types';

/**
 * Metadata symbol key: list of class fields marked with {@link UseRef}.
 *
 * Filled by the decorator on the constructor; read by {@link getRefFields} and GraphRuntime on mount
 * to match the field with the node passed via `h(..., ref)`.
 */
export const REF_FIELDS_META_KEY = Symbol('effectable:ref_fields');

/**
 * Metadata symbol key: list of methods marked with {@link UseImperativeHandle}.
 *
 * GraphRuntime builds a limited public handle (imperative API) from them without exposing other class methods.
 */
export const IMPERATIVE_HANDLE_META_KEY = Symbol('effectable:imperative_handle');

/**
 * Record for a field registered by the {@link UseRef} decorator.
 *
 * Used by the runtime to bind a child component instance to the parent's ref.
 */
export interface RefFieldMeta {
  /** Property key on the component instance (`string` or `symbol`). */
  propertyKey: string | symbol;
}

/**
 * Record for a method registered by the {@link UseImperativeHandle} decorator.
 *
 * Participates in building the public imperative API of the child node's ref.
 */
export interface ImperativeHandleMeta {
  /** Method key on the component instance (`string` or `symbol`). */
  methodKey: string | symbol;
}

/**
 * Component class property decorator: lazily creates a `RefObject` and registers the field in {@link REF_FIELDS_META_KEY}.
 *
 * On first getter access, one `RefObject` is created per instance; the same ref is passed to `h(Child, {}, this.childRef)`.
 * GraphRuntime fills `current` when the child node mounts.
 *
 * @returns {PropertyDecorator} property decorator: getter returns a stable `RefObject` for the child node
 * @example
 * class Parent extends Component {
 *   @UseRef()
 *   private declare childRef: RefObject<Child>;
 *
 *   compose() {
 *     return h(Child, {}, this.childRef);
 *   }
 * }
 */
export function UseRef (): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol): void {
    const constructor = target.constructor as {
      [REF_FIELDS_META_KEY]?: RefFieldMeta[];
    };

    const current = constructor[REF_FIELDS_META_KEY];
    const isInherited = current !== undefined && !Object.hasOwn(constructor, REF_FIELDS_META_KEY);

    const next = isInherited ? [...current] : (current ?? []);
    next.push({ propertyKey });

    constructor[REF_FIELDS_META_KEY] = next;

    const refKey = `__ref_${String(propertyKey)}`;

    Object.defineProperty(target, propertyKey, {
      get (this: Record<string | symbol, unknown>) {
        if (this[refKey] === undefined) {
          this[refKey] = { current: null } as RefObject<unknown>;
        }

        return this[refKey];
      },
      enumerable: true,
      configurable: true,
    });
  };
}

/**
 * Component class method decorator: adds the method to the {@link IMPERATIVE_HANDLE_META_KEY} list.
 *
 * GraphRuntime builds the public imperative handle only from such methods; other class methods
 * are not reachable via ref. The method itself is not overridden — only registered as metadata on the constructor.
 *
 * @returns {MethodDecorator} method decorator that leaves `descriptor` unchanged (side effect only — write meta)
 * @example
 * class Child extends Component {
 *   @UseImperativeHandle()
 *   public async reset(): Promise<void> {
 *     // ...
 *   }
 * }
 */
export function UseImperativeHandle (): MethodDecorator {
  return function (
    target: object,
    methodKey: string | symbol,
    _descriptor: PropertyDescriptor,
  ): void {
    const constructor = target.constructor as {
      [IMPERATIVE_HANDLE_META_KEY]?: ImperativeHandleMeta[];
    };

    const current = constructor[IMPERATIVE_HANDLE_META_KEY];
    const isInherited = current !== undefined && !Object.hasOwn(constructor, IMPERATIVE_HANDLE_META_KEY);

    const next = isInherited ? [...current] : (current ?? []);
    next.push({ methodKey });

    constructor[IMPERATIVE_HANDLE_META_KEY] = next;
  };
}

/**
 * Returns the array of fields registered by {@link UseRef} on the given component constructor.
 *
 * If meta is absent, returns a new empty array. If meta is present, returns the same array stored
 * on the constructor (external mutations affect the metadata).
 *
 * @param {object} componentClass - component constructor: object with optional {@link REF_FIELDS_META_KEY}
 * @returns {RefFieldMeta[]} ref field records; order matches decorator application order
 */
export function getRefFields (
  componentClass: { [REF_FIELDS_META_KEY]?: RefFieldMeta[] },
): readonly RefFieldMeta[] {
  const fields = componentClass[REF_FIELDS_META_KEY];
  return fields === undefined ? [] : [...fields];
}

/**
 * Returns the array of methods registered by {@link UseImperativeHandle} on the given constructor.
 *
 * If meta is absent, returns a new empty array. If meta is present, returns a copy
 * of the internal array (external mutations do not affect the metadata).
 *
 * @param {object} componentClass - component constructor: object with optional {@link IMPERATIVE_HANDLE_META_KEY}
 * @returns {readonly ImperativeHandleMeta[]} imperative API method records; order matches decorator application order
 */
export function getImperativeHandleMethods (
  componentClass: { [IMPERATIVE_HANDLE_META_KEY]?: ImperativeHandleMeta[] },
): readonly ImperativeHandleMeta[] {
  const methods = componentClass[IMPERATIVE_HANDLE_META_KEY];
  return methods === undefined ? [] : [...methods];
}
