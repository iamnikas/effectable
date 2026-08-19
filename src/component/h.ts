/**
 * VirtualServiceNode factory for declarative component tree composition.
 * Declarative element factory for a backend runtime graph (virtual service nodes).
 *
 * h() describes topology with no side effects — no network calls,
 * subscriptions, or handler registration inside an h() call.
 *
 * @module Effectable/component/h
 */

import type { ComponentConstructor, RefObject, VirtualServiceNode } from './types';

/**
 * Singleton: immutable empty children array used by default.
 *
 * Used in {@link h} when no children are passed, to avoid allocating `[]` on every call.
 * `Object.freeze` preserves the immutability invariant of the {@link VirtualServiceNode} structure.
 */
const EMPTY_CHILDREN: readonly VirtualServiceNode[] = Object.freeze([]) as readonly VirtualServiceNode[];

/** Empty props: `Record<string, never>` — omit the second argument to `h`. */
type EmptyProps = Record<string, never>;

/**
 * Creates a VirtualServiceNode — a declarative node description for GraphRuntime.
 *
 * Overloads:
 * - h(type) — node with empty props (`Record<string, never>`), without `{}`
 * - h(type, props) — node without ref/children/key
 * - h(type, props, key) — node with key only (for dynamic lists)
 * - h(type, props, children) — node with children
 * - h(type, props, children, key) — node with children and key
 * - h(type, props, ref) — node with ref
 * - h(type, props, ref, key) — node with ref and key
 * - h(type, props, ref, children) — node with ref and children
 * - h(type, props, ref, children, key) — node with ref, children, and key
 *
 * `key` — stable identity key for diffing dynamic lists.
 * Detected via `typeof === 'string'` in any free positional slot.
 *
 * @param {new (props: P) => Component<unknown, P>} type - component class
 * @param {P} [props] - component props; omit for empty props
 * @param {RefObject<unknown> | VirtualServiceNode[] | string | undefined} refOrChildrenOrKey - ref, children, or key
 * @param {VirtualServiceNode[] | string | undefined} childrenOrKey - children or key
 * @param {string | undefined} maybeKey - explicit key (when ref and children slots are already used)
 * @returns {VirtualServiceNode<P>} virtual node
 * @example
 * h(SharedClientServiceComponent)
 * h(OrderService, { symbol: 'BTCUSDT' })
 * h(OrderService, { symbol: 'BTCUSDT' }, ordersRef)
 * h(ContextProvider, { value: [DB_CONTEXT, db] }, [h(DeepChild)])
 * h(Parent, undefined, parentRef, [h(Child)])
 * h(PairMonitor, { pair: 'BTCUSDT' }, 'btc')
 * h(PairMonitor, { pair: 'BTCUSDT' }, parentRef, [h(Child)], 'btc')
 */
export function h (
  type: ComponentConstructor<EmptyProps>,
): VirtualServiceNode<EmptyProps>;
export function h<P> (
  type: ComponentConstructor<P>,
  props: P,
  refOrChildrenOrKey?: RefObject<unknown> | VirtualServiceNode[] | string,
  childrenOrKey?: VirtualServiceNode[] | string,
  maybeKey?: string,
): VirtualServiceNode<P>;
export function h<P> (
  type: ComponentConstructor<P>,
  props?: P,
  refOrChildrenOrKey?: RefObject<unknown> | VirtualServiceNode[] | string,
  childrenOrKey?: VirtualServiceNode[] | string,
  maybeKey?: string,
): VirtualServiceNode<P> {
  const resolvedProps = (props === undefined ? {} : props) as P;

  // Fast-path: most common case — h(type) / h(type, props) without ref/children/key.
  // Return a shape-stable object without intermediate checks (41x speedup).
  if (refOrChildrenOrKey === undefined) {
    return {
      type: type as ComponentConstructor<unknown>,
      props: resolvedProps,
      ref: undefined,
      children: EMPTY_CHILDREN as VirtualServiceNode[],
    };
  }

  let resolvedRef: RefObject<unknown> | undefined;
  let resolvedChildren: VirtualServiceNode[];
  let resolvedKey: string | undefined;

  if (typeof refOrChildrenOrKey === 'string') {
    resolvedRef = undefined;
    resolvedChildren = EMPTY_CHILDREN as VirtualServiceNode[];
    resolvedKey = refOrChildrenOrKey;
  } else if (Array.isArray(refOrChildrenOrKey)) {
    resolvedRef = undefined;
    resolvedChildren = refOrChildrenOrKey;
    resolvedKey = typeof childrenOrKey === 'string' ? childrenOrKey : undefined;
  } else {
    resolvedRef = refOrChildrenOrKey;
    if (typeof childrenOrKey === 'string') {
      resolvedChildren = EMPTY_CHILDREN as VirtualServiceNode[];
      resolvedKey = childrenOrKey;
    } else {
      resolvedChildren = childrenOrKey ?? (EMPTY_CHILDREN as VirtualServiceNode[]);
      resolvedKey = maybeKey;
    }
  }

  if (resolvedKey === undefined) {
    return {
      type: type as ComponentConstructor<unknown>,
      props: resolvedProps,
      ref: resolvedRef,
      children: resolvedChildren,
    };
  }

  return {
    type: type as ComponentConstructor<unknown>,
    props: resolvedProps,
    ref: resolvedRef,
    children: resolvedChildren,
    key: resolvedKey,
  };
}
