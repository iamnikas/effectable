/**
 * **Context** machinery (dependency injection down the component tree): passes dependencies
 * without threading props through every level (prop drilling).
 *
 * **Data flow**
 * 1. {@link createContext} — declares a typed {@link ContextToken}.
 * 2. {@link ContextProvider} in the virtual node tree extends {@link ContextScope}.
 * 3. {@link UseContext} marks class fields; during materialization {@link injectContextFields}
 *    fills them from the scope (after instance creation, before startup).
 *
 * **Conventions**
 * - Tokens are always typed; the scope key is `token.key` ({@link ContextToken.key}).
 * - Context is for infrastructure / cross-cutting dependencies, not a substitute for explicit domain contracts.
 * - No provider and no `defaultValue` on the token — {@link readFromScope} and {@link injectContextFields}
 *   throw (missing required provider).
 * - {@link GraphRuntime} inherits scope from parent to children when materializing nodes.
 *
 * @module Effectable/component/context
 */

import { Component } from './Component';
import type { VirtualServiceNode } from './types';

// ---------------------------------------------------------------------------
// ContextToken
// ---------------------------------------------------------------------------

/**
 * Unique context token: identifier of type `T` in {@link ContextScope}.
 * Created only via {@link createContext}; two calls with the same `displayName` yield different `key`s.
 * For a process-wide singleton token, store the `createContext` result in a module constant.
 *
 * @template T type of the value stored in scope for this token
 */
export interface ContextToken<T> {
  /** Human-readable name (logs, error messages); preferably unique in the project. */
  readonly displayName: string;
  /**
   * Value when there is no entry in scope: used by {@link readFromScope}.
   * If `undefined` and there is no scope entry — reading is a tree configuration error.
   */
  readonly defaultValue: T | undefined;
  /** Internal entry key in {@link ContextScope} (do not mix with foreign `symbol`s). */
  readonly key: symbol;
}

/**
 * Immutable snapshot of “token → value” bindings for the current tree node.
 * Keys are `ContextToken.key`; values are cast to the token type on read.
 * Extended only by creating a new map ({@link extendScope}, {@link ContextProvider.applyToScope}).
 */
export type ContextScope = ReadonlyMap<symbol, unknown>;

/**
 * Initial scope before the first {@link ContextProvider}: empty map.
 * Root runtime usually starts with this reference and accumulates layers down the tree.
 */
export const EMPTY_CONTEXT_SCOPE: ContextScope = new Map();

/**
 * Declares a new {@link ContextToken}: factory for later use in
 * {@link ContextProvider} and {@link UseContext}.
 *
 * @template T value type in scope
 * @param {string} displayName - name for logs and `Symbol(displayName)`; keep it stable across refactors
 * @param {T} [defaultValue] - fallback if no {@link ContextProvider} node placed the token in scope
 * @returns {ContextToken<T>} token with a unique {@link ContextToken.key}
 * @example
 * const DB_CONTEXT = createContext<DatabaseService>('DB_CONTEXT');
 * const CLOCK_CONTEXT = createContext<Clock>('CLOCK_CONTEXT', new SystemClock());
 */
export function createContext<T> (
  displayName: string,
  defaultValue?: T,
): ContextToken<T> {
  return {
    displayName,
    defaultValue,
    key: Symbol(displayName),
  };
}

/**
 * Returns a **new** {@link ContextScope} with entry `token.key → value`, without mutating `scope`.
 * Writing the same key again overwrites the value in the returned map (last provider wins).
 *
 * @template T value type consistent with the token
 * @param {ContextScope} scope - source scope (often the parent's)
 * @param {ContextToken<T>} token - token under which the value is stored
 * @param {T} value - dependency instance for the subtree
 * @returns {ContextScope} new scope to pass to child nodes
 */
export function extendScope<T> (
  scope: ContextScope,
  token: ContextToken<T>,
  value: T,
): ContextScope {
  const next = new Map(scope);
  next.set(token.key, value);
  return next;
}

/**
 * Reads the value for `token` from `scope`: first the entry at `token.key`, otherwise {@link ContextToken.defaultValue}.
 * Used for field injection and in code that needs explicit scope access without a decorator.
 *
 * @template T expected value type
 * @param {ContextScope} scope - node scope at read time
 * @param {ContextToken<T>} token - requested token
 * @returns {T} value from scope or the token default
 * @throws {Error} if the key is missing in scope and the token has no `defaultValue` (no provider up the tree)
 */
export function readFromScope<T> (scope: ContextScope, token: ContextToken<T>): T {
  if (scope.has(token.key)) {
    return scope.get(token.key) as T;
  }

  if (token.defaultValue !== undefined) {
    return token.defaultValue;
  }

  throw new Error(
    `[Effectable] Context token "${token.displayName}" is not provided. ` +
    'Make sure that a ContextProvider with this token exists higher in the component tree.',
  );
}

// ---------------------------------------------------------------------------
// ContextProvider
// ---------------------------------------------------------------------------

/**
 * Props of a {@link ContextProvider} node: what to put into the child {@link ContextScope}.
 * The shape of `value` differs by array form (one pair vs array of pairs) — see {@link ContextProvider.applyToScope}.
 */
export interface ContextProviderProps {
  /**
   * Either a single pair `[token, value]`, or an array of pairs `[[t1, v1], [t2, v2], ...]`.
   * Do not mix “one pair” and “array of pairs” in one value — distinguished by `Array.isArray(value[0])`.
   *
   * @example One token
   * { value: [DB_CONTEXT, dbInstance] }
   * @example Multiple tokens
   * { value: [[DB_CONTEXT, db], [CLOCK_CONTEXT, clock]] }
   */
  value:
    | [ContextToken<unknown>, unknown]
    | Array<[ContextToken<unknown>, unknown]>;
}

/**
 * Virtual node with no UI of its own: only extends {@link ContextScope} for descendants.
 * Runtime calls {@link applyToScope} during materialization and passes the result to child nodes.
 * Provider detection without `instanceof`: {@link IS_CONTEXT_PROVIDER} is set on the prototype.
 *
 * @example
 * compose() {
 *   return h(ContextProvider, { value: [DB_CONTEXT, this.db] }, [
 *     h(DeepChild, {})
 *   ]);
 * }
 */
export class ContextProvider extends Component<
  Record<string, unknown>,
  ContextProviderProps
> {
  /**
   * @param {ContextProviderProps} props - token–value pairs for the subtree
   */
  constructor (props: ContextProviderProps) {
    super(props);
  }

  /**
   * Builds the child scope: copies `parentScope` and overlays entries from {@link ContextProviderProps.value}.
   * Pair order in the array matters on token collision — the last pair wins.
   *
   * For multiple pairs: one parent copy only if `parentScope` is non-empty; when `size === 0`
   * build a fresh `Map` without `new Map(parentScope)` (avoids an extra entry walk).
   * A single pair in array form — delegates to {@link extendScope} (same path as one pair in props).
   *
   * @param {ContextScope} parentScope - scope inherited from ancestors
   * @returns {ContextScope} scope for this provider's child components
   */
  public applyToScope (parentScope: ContextScope): ContextScope {
    const { value } = this.props;

    if (Array.isArray(value) && Array.isArray(value[0])) {
      const pairs = value as Array<[ContextToken<unknown>, unknown]>;
      const n = pairs.length;

      if (n === 1) {
        const p = pairs[0] as [ContextToken<unknown>, unknown];
        return extendScope(parentScope, p[0], p[1]);
      }

      let next: Map<symbol, unknown>;

      if (parentScope.size === 0) {
        next = new Map();
      } else {
        next = new Map(parentScope);
      }

      for (let i = 0; i < n; i += 1) {
        const p = pairs[i] as [ContextToken<unknown>, unknown];
        next.set(p[0].key, p[1]);
      }

      return next;
    }

    // Single pair: [token, value]
    const [token, val] = value as [ContextToken<unknown>, unknown];
    return extendScope(parentScope, token, val);
  }

  /**
   * The provider does not render children itself — that is done by the parent's compose/h;
   * the node exists only to participate in scope computation.
   *
   * @returns {null} no child virtual nodes
   */
  public override compose (): VirtualServiceNode[] | null {
    return null;
  }
}

/**
 * Marker on {@link ContextProvider.prototype}: fast “is this a provider?” check without `instanceof`
 * (hot-path optimization in the runtime). Declared before {@link Object.defineProperty}, which hangs the flag on the prototype.
 */
export const IS_CONTEXT_PROVIDER = Symbol('effectable:is_context_provider');

// Symbol flag on prototype for O(1) detection instead of instanceof (1.90x on negative path)
Object.defineProperty(ContextProvider.prototype, IS_CONTEXT_PROVIDER, {
  value: true,
  writable: false,
  enumerable: false,
  configurable: false,
});

// ---------------------------------------------------------------------------
// @UseContext decorator
// ---------------------------------------------------------------------------

/**
 * Metadata key on the constructor: array of {@link ContextFieldMeta} for fields with {@link UseContext}.
 * Filled by the decorator when the class loads.
 */
export const CONTEXT_FIELDS_META_KEY = Symbol('effectable:context_fields');

/**
 * Marker on the constructor: `true` if the class has at least one {@link UseContext} field.
 * Lets {@link injectContextFields} exit immediately for “pure” components without extra walks.
 */
export const HAS_CONTEXT_FIELDS_KEY = Symbol('effectable:has_context_fields');

/**
 * Metadata record for one field marked with {@link UseContext}: what and from where to fill.
 */
export interface ContextFieldMeta {
  /** Property key on the instance (as in the class declaration). */
  propertyKey: string | symbol;
  /** Token; the actual value is taken via {@link readFromScope} in {@link injectContextFields}. */
  token: ContextToken<unknown>;
}

/**
 * **Field** decorator for a {@link Component} class: after instance creation the runtime assigns
 * to the property the result of {@link readFromScope} for the given token and the node's current scope.
 * Metadata accumulates under {@link CONTEXT_FIELDS_META_KEY}; class field order is assignment order.
 *
 * @template T field type (must match the token value type)
 * @param {ContextToken<T>} token - which context to inject
 * @returns {PropertyDecorator} standard Stage 3 property decorator
 * @example
 * class DeepChild extends Component {
 *   @UseContext(DB_CONTEXT) private db!: DatabaseService;
 * }
 */
export function UseContext<T> (token: ContextToken<T>): PropertyDecorator {
  return function (target: object, propertyKey: string | symbol): void {
    const constructor = target.constructor as {
      [CONTEXT_FIELDS_META_KEY]?: ContextFieldMeta[];
      [HAS_CONTEXT_FIELDS_KEY]?: true;
    };

    if (!Array.isArray(constructor[CONTEXT_FIELDS_META_KEY])) {
      constructor[CONTEXT_FIELDS_META_KEY] = [];
    }

    // Set the fast-path flag when registering the first field
    if (!constructor[HAS_CONTEXT_FIELDS_KEY]) {
      constructor[HAS_CONTEXT_FIELDS_KEY] = true;
    }

    const existing = constructor[CONTEXT_FIELDS_META_KEY];

    if (existing !== undefined) {
      existing.push({ propertyKey, token: token as ContextToken<unknown> });
    }
  };
}

/**
 * Snapshot of metadata collected by the {@link UseContext} decorator for the given constructor.
 * If the decorator was never applied — returns an empty array.
 *
 * @param {{ [CONTEXT_FIELDS_META_KEY]?: ContextFieldMeta[] }} componentClass - component constructor
 * @returns {ContextFieldMeta[]} logical field list (external array mutations are discouraged)
 */
export function getContextFields (
  componentClass: { [CONTEXT_FIELDS_META_KEY]?: ContextFieldMeta[] },
): ContextFieldMeta[] {
  return componentClass[CONTEXT_FIELDS_META_KEY] ?? [];
}

/**
 * Fills all {@link UseContext} fields: for each {@link ContextFieldMeta} entry calls
 * {@link readFromScope} and assigns the instance property. When {@link HAS_CONTEXT_FIELDS_KEY}
 * is absent on the constructor, exits without work (fast path).
 * Called by the runtime after `new Component(...)` and before user startup.
 *
 * @param {object} instance - already created component instance
 * @param {ContextScope} scope - scope computed for this node (including ancestor providers)
 * @returns {void}
 * @throws {Error} see {@link readFromScope} — required token missing from scope
 */
export function injectContextFields (
  instance: object,
  scope: ContextScope,
): void {
  const constructor = instance.constructor as {
    [CONTEXT_FIELDS_META_KEY]?: ContextFieldMeta[];
    [HAS_CONTEXT_FIELDS_KEY]?: true;
  };

  // Fast-path: most HFT components do not use @UseContext (1.68x at 80% pure)
  if (!constructor[HAS_CONTEXT_FIELDS_KEY]) {
    return;
  }

  const fields = constructor[CONTEXT_FIELDS_META_KEY] as ContextFieldMeta[];
  const target = instance as Record<string | symbol, unknown>;
  const n = fields.length;

  // Tight for-index loop without iterator allocation + inline single Map.get
  // (13_EXP4 / P010, 1.37x incremental — part of the overall sync fast-path stack).
  for (let i = 0; i < n; i++) {
    const meta = fields[i] as ContextFieldMeta;
    const token = meta.token;
    const v = scope.get(token.key);

    if (v !== undefined) {
      target[meta.propertyKey] = v;
    } else if (scope.has(token.key)) {
      // Rare case: token is actually present with value undefined.
      target[meta.propertyKey] = undefined;
    } else if (token.defaultValue !== undefined) {
      target[meta.propertyKey] = token.defaultValue;
    } else {
      throw new Error(
        `[Effectable] Context token "${token.displayName}" is not provided. ` +
        'Make sure that a ContextProvider with this token exists higher in the component tree.',
      );
    }
  }
}
