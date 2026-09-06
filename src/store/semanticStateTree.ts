/**
 * Builds a semantic JSON tree from a store state snapshot / reducer map.
 *
 * Reducers at runtime do not describe data shape without initial state, so
 * the walk is performed over the provided `initialState` (or `store.getState()`),
 * and the `{ slice: reducer }` map is used to align slice keys with the root state.
 *
 * @module Effectable/store/semanticStateTree
 */

import type { Action, Reducer, Store } from './types';

/**
 * Primitive kind in the semantic tree.
 */
export type SemanticJsonPrimitiveKind =
  | 'null'
  | 'undefined'
  | 'boolean'
  | 'number'
  | 'string'
  | 'bigint'
  | 'symbol';

/**
 * Semantic tree node suitable for `JSON.stringify`.
 */
export type SemanticJsonNode =
  | {
    kind: 'primitive';
    valueType: SemanticJsonPrimitiveKind;
  }
  | {
    kind: 'date';
    iso: string;
  }
  | {
    kind: 'array';
    length: number;
    item: SemanticJsonNode | null;
  }
  | {
    kind: 'object';
    keys: Record<string, SemanticJsonNode>;
  }
  | {
    kind: 'reference';
    reused: true;
  }
  | {
    kind: 'truncated';
    maxDepthExceeded: true;
  }
  | {
    kind: 'nonSerializable';
    description: string;
  };

/**
 * Options for building the tree.
 */
export interface BuildSemanticStateTreeOptions {
  /**
   * Maximum nesting depth (root counts as depth 0).
   */
  maxDepth?: number;
  /**
   * Maximum keys on a single object (the rest are listed as `__overflow`).
   */
  maxKeysPerObject?: number;
}

const DEFAULT_MAX_DEPTH = 32;
const DEFAULT_MAX_KEYS = 500;

/**
 * Internal option values with defaults applied.
 */
interface ResolvedBuildSemanticStateTreeOptions {
  maxDepth: number;
  maxKeysPerObject: number;
}

/**
 * Resolve tree-building options.
 *
 * @param {BuildSemanticStateTreeOptions | undefined} options - user options
 * @returns {ResolvedBuildSemanticStateTreeOptions} values with defaults
 */
function resolveOptions (options: BuildSemanticStateTreeOptions | undefined): ResolvedBuildSemanticStateTreeOptions {
  const maxDepth =
    typeof options?.maxDepth === 'number' && Number.isFinite(options.maxDepth) && options.maxDepth >= 0
      ? Math.floor(options.maxDepth)
      : DEFAULT_MAX_DEPTH;
  const maxKeysPerObject =
    typeof options?.maxKeysPerObject === 'number' &&
    Number.isFinite(options.maxKeysPerObject) &&
    options.maxKeysPerObject >= 1
      ? Math.floor(options.maxKeysPerObject)
      : DEFAULT_MAX_KEYS;
  return {
    maxDepth,
    maxKeysPerObject,
  };
}

/**
 * Check for a “plain” object (not an array and not null).
 *
 * @param {unknown} value - value to check
 * @returns {boolean} true if it is a plain object
 */
function isPlainObject (value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto === null) {
    return true;
  }
  if (proto === Object.prototype) {
    return true;
  }
  return false;
}

/**
 * Build a tree node for an arbitrary value.
 *
 * @param {unknown} value - value from state
 * @param {number} depth - current depth
 * @param {WeakSet<object>} visited - already visited objects (for references)
 * @param {ResolvedBuildSemanticStateTreeOptions} options - resolved options
 * @returns {SemanticJsonNode} tree node
 */
function buildNode (
  value: unknown,
  depth: number,
  visited: WeakSet<object>,
  options: ResolvedBuildSemanticStateTreeOptions
): SemanticJsonNode {
  if (depth > options.maxDepth) {
    return {
      kind: 'truncated',
      maxDepthExceeded: true,
    };
  }

  if (value === null) {
    return {
      kind: 'primitive',
      valueType: 'null',
    };
  }

  if (value === undefined) {
    return {
      kind: 'primitive',
      valueType: 'undefined',
    };
  }

  const typeofValue = typeof value;

  if (typeofValue === 'boolean') {
    return {
      kind: 'primitive',
      valueType: 'boolean',
    };
  }

  if (typeofValue === 'number') {
    return {
      kind: 'primitive',
      valueType: 'number',
    };
  }

  if (typeofValue === 'string') {
    return {
      kind: 'primitive',
      valueType: 'string',
    };
  }

  if (typeofValue === 'bigint') {
    return {
      kind: 'primitive',
      valueType: 'bigint',
    };
  }

  if (typeofValue === 'symbol') {
    return {
      kind: 'primitive',
      valueType: 'symbol',
    };
  }

  if (typeofValue === 'function') {
    return {
      kind: 'nonSerializable',
      description: 'function',
    };
  }

  if (typeof value === 'object') {
    if (value instanceof Date) {
      return {
        kind: 'date',
        iso: value.toISOString(),
      };
    }

    if (visited.has(value)) {
      return {
        kind: 'reference',
        reused: true,
      };
    }

    visited.add(value);

    if (Array.isArray(value)) {
      const length = value.length;
      let item: SemanticJsonNode | null = null;
      if (length > 0) {
        item = buildNode(value[0], depth + 1, visited, options);
      }
      return {
        kind: 'array',
        length,
        item,
      };
    }

    if (isPlainObject(value)) {
      const keys = Object.keys(value);
      // Null-prototype bag: `keysOut[key] =` on a normal `{}` invokes the
      // `__proto__` setter when `key === '__proto__'`, replacing [[Prototype]]
      // with the child node, dropping the key from Object.keys, and leaking
      // inherited fields (e.g. `keys.kind`) onto the bag.
      const keysOut: Record<string, SemanticJsonNode> = Object.create(null);
      const limit = options.maxKeysPerObject;
      let processed = 0;
      for (let i = 0; i < keys.length; i++) {
        if (processed >= limit) {
          break;
        }
        const key = keys[i];
        if (key === undefined) {
          continue;
        }
        if (!Object.hasOwn(value, key)) {
          continue;
        }
        const child: unknown = Reflect.get(value, key);
        keysOut[key] = buildNode(child, depth + 1, visited, options);
        processed = processed + 1;
      }
      const omitted = keys.length - processed;
      if (omitted > 0) {
        keysOut['__semanticOverflow'] = {
          kind: 'nonSerializable',
          description: `omitted keys: ${String(omitted)}`,
        };
      }
      return {
        kind: 'object',
        keys: keysOut,
      };
    }

    const ctor = value.constructor;
    const name = ctor !== undefined && ctor !== null && typeof ctor.name === 'string' ? ctor.name : 'Object';
    return {
      kind: 'nonSerializable',
      description: `instance:${name}`,
    };
  }

  return {
    kind: 'nonSerializable',
    description: 'unknown',
  };
}

/**
 * Build a semantic tree from an arbitrary state snapshot (root is a single node).
 *
 * @param {unknown} state - root state or any fragment
 * @param {BuildSemanticStateTreeOptions} [options] - depth and key-count limits
 * @returns {SemanticJsonNode} tree serializable to JSON
 */
export function buildSemanticStateTree (state: unknown, options?: BuildSemanticStateTreeOptions): SemanticJsonNode {
  const resolved = resolveOptions(options);
  const visited = new WeakSet<object>();
  return buildNode(state, 0, visited, resolved);
}

/**
 * Build a semantic tree from the store's current state.
 *
 * @template S - store state type
 * @template A - store action type
 * @param {Store<S, A>} store - store instance from `createStore`
 * @param {BuildSemanticStateTreeOptions} [options] - depth and key-count limits
 * @returns {SemanticJsonNode} state tree
 */
export function buildSemanticStateTreeFromStore<S, A extends Action = Action> (
  store: Store<S, A>,
  options?: BuildSemanticStateTreeOptions
): SemanticJsonNode {
  return buildSemanticStateTree(store.getState(), options);
}

/**
 * Build a semantic tree from a reducer map and a matching initial state.
 * Keys of `reducerMap` and `initialState` must match as sets (otherwise an error is thrown).
 *
 * @param {Record<string, Reducer<unknown, Action>>} reducerMap - map of slice names to reducers
 * @param {Record<string, unknown>} initialState - initial state with the same keys
 * @param {BuildSemanticStateTreeOptions} [options] - depth and key-count limits
 * @returns {SemanticJsonNode} state tree
 */
export function buildSemanticStateTreeFromReducerMap (
  reducerMap: Record<string, Reducer<unknown, Action>>,
  initialState: Record<string, unknown>,
  options?: BuildSemanticStateTreeOptions
): SemanticJsonNode {
  const reducerKeys = Object.keys(reducerMap);
  for (let i = 0; i < reducerKeys.length; i++) {
    const key = reducerKeys[i];
    if (key === undefined) {
      continue;
    }
    if (!Object.hasOwn(initialState, key)) {
      throw new Error(`buildSemanticStateTreeFromReducerMap: initialState does not contain key "${key}" from reducerMap`);
    }
  }

  const stateKeys = Object.keys(initialState);
  for (let i = 0; i < stateKeys.length; i++) {
    const key = stateKeys[i];
    if (key === undefined) {
      continue;
    }
    if (!Object.hasOwn(reducerMap, key)) {
      throw new Error(`buildSemanticStateTreeFromReducerMap: reducerMap does not contain key "${key}" from initialState`);
    }
  }

  return buildSemanticStateTree(initialState, options);
}

/**
 * Serialize a semantic tree to a JSON string (with indentation by default).
 *
 * @param {unknown} state - root state
 * @param {BuildSemanticStateTreeOptions} [options] - tree options
 * @param {number | string} [space] - indent for `JSON.stringify` (default 2)
 * @returns {string} JSON string
 */
export function semanticStateTreeToJsonString (
  state: unknown,
  options?: BuildSemanticStateTreeOptions,
  space: number | string = 2
): string {
  const tree = buildSemanticStateTree(state, options);
  return JSON.stringify(tree, null, space);
}
