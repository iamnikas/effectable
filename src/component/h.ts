/**
 * VirtualServiceNode factory for declarative component tree composition.
 * Declarative element factory for a backend runtime graph (virtual service nodes).
 *
 * h() describes topology with no side effects — no network calls,
 * subscriptions, or handler registration inside an h() call.
 *
 * @module Effectable/component/h
 */

import type { Component } from './Component';
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
 * Named erase of a concrete `RefObject<C>` into the vnode store type `RefObject<unknown>`.
 *
 * `RefObject<T>` is covariant in practice (writable data property, no `in out T`), so
 * `RefObject<Child>` → `RefObject<unknown>` already type-checks — no assertion and no
 * branding. This helper only centralizes the store-boundary widening next to the existing
 * `type as ComponentConstructor<unknown>` erase. Do not add `in out T` to {@link RefObject}.
 *
 * The reason {@link h} is generic over `C` is **call-site matching** (reject `Other` /
 * wide `Component` / `unknown` refs), not to make Child assignable to the store.
 *
 * @template C Concrete instance type carried by the caller’s ref
 * @param {RefObject<C>} ref - typed ref from the caller
 * @returns {RefObject<unknown>} same object, typed for {@link VirtualServiceNode.ref}
 */
function eraseRef<C> (ref: RefObject<C>): RefObject<unknown> {
  return ref;
}

/**
 * Creates a VirtualServiceNode — a declarative node description for GraphRuntime.
 *
 * Overloads:
 * - h(type) — node with empty props (`Record<string, never>`), without `{}`
 * - h(type, props) — node without ref/children/key
 * - h(type, props, key) — node with key only (for dynamic lists)
 * - h(type, props, children) — node with children
 * - h(type, props, children, key) — node with children and key
 * - h(type, props, ref) — node with ref (`RefObject<C>` matching the instance)
 * - h(type, props, ref, key) — node with ref and key
 * - h(type, props, ref, children) — node with ref and children
 * - h(type, props, ref, children, key) — node with ref, children, and key
 *
 * `key` — stable identity key for diffing dynamic lists.
 * Detected via `typeof === 'string'` in any free positional slot.
 *
 * Generic over instance type `C` for **call-site matching**: `h(Child, props, childRef)`
 * stays OK while `otherRef` / wide `Component` / `unknown` refs are type errors.
 * `type` is `new (props: P) => C` (not `ComponentConstructor<P>`) so `C` does not collapse
 * to `Component<unknown, P>`. `NoInfer` on `props` and on `RefObject<C>` keeps `P`/`C`
 * inferred from the constructor, not from the props literal or the ref argument.
 * {@link VirtualServiceNode.ref} stays `RefObject<unknown>`; store widening is {@link eraseRef}.
 *
 * @param {new (props: P) => C} type - component class
 * @param {P} [props] - component props; omit for empty props
 * @param {RefObject<C> | VirtualServiceNode[] | string | undefined} refOrChildrenOrKey - ref, children, or key
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
export function h<C extends Component<unknown, EmptyProps>> (
  type: new (props: EmptyProps) => C,
): VirtualServiceNode<EmptyProps>;
export function h<P, C extends Component<unknown, P>> (
  type: new (props: P) => C,
  props: NoInfer<P>,
  refOrChildrenOrKey?: RefObject<NoInfer<C>> | VirtualServiceNode[] | string,
  childrenOrKey?: VirtualServiceNode[] | string,
  maybeKey?: string,
): VirtualServiceNode<P>;
export function h<P, C extends Component<unknown, P>> (
  type: new (props: P) => C,
  props?: NoInfer<P>,
  refOrChildrenOrKey?: RefObject<NoInfer<C>> | VirtualServiceNode[] | string,
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
    resolvedRef = eraseRef(refOrChildrenOrKey);
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
