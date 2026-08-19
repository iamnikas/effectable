/**
 * Lifecycle and Disposable types for Effectable/component.
 * Lifecycle contract and Explicit Resource Management (TS 5.2+, Symbol.dispose).
 * Also includes VirtualServiceNode, Fiber, and NodeLifecycleStatus types for declarative component trees.
 *
 * @module Effectable/component/types
 */

import type { Component } from './Component';

/**
 * Lifecycle interface for a GraphRuntime / connect-HOC component instance.
 * Methods are called in order: onMount -> onStateUpdate/onPropsUpdate/onContextUpdate* -> onUnmount.
 */
export interface Lifecycle {
  /** Mount: start subscriptions, timers, and background work. */
  onMount?(): void | Promise<void>;
  /**
   * @deprecated Use {@link onStateUpdate}, {@link onPropsUpdate}, or {@link onContextUpdate} instead.
   * onUpdate will be removed in the next major release.
   * 
   * On every state/props update (prev/next).
   * ISSUE: This hook was ambiguous — GraphRuntime called it with props, but Component.setState called it with state.
   */
  onUpdate?(prev: unknown, next: unknown): void | Promise<void>;
  /** Called after state changes via setState. Receives previous and next state. */
  onStateUpdate?(prev: unknown, next: unknown): void | Promise<void>;
  /** Called after props change during reconcile. Receives previous and next props. */
  onPropsUpdate?(prev: unknown, next: unknown): void | Promise<void>;
  /** Called after context values change. Receives previous and next context. */
  onContextUpdate?(prev: unknown, next: unknown): void | Promise<void>;
  /** Unmount: drop subscriptions and stop side effects. */
  onUnmount?(): void | Promise<void>;
}

/**
 * Internal runtime hook for components that need custom application of incoming `props`
 * during reconcile instead of a direct `instance.props = nextProps`.
 *
 * Used by `connect`-HOC to update props and rebuild merged props
 * (`props + dispatch props + state props`) without losing previously computed values.
 */
export const RUNTIME_PROPS_RECEIVER = Symbol('effectable:runtime_props_receiver');

/**
 * Hidden scheduler hook: GraphRuntime writes this symbol onto a mounted instance after
 * successful startup. `Component.setState()` invokes it after `onUpdate` so GraphRuntime
 * can schedule an automatic subtree reconcile without an explicit external call.
 *
 * Cleared by GraphRuntime before `runShutdown` on unmount.
 * Absence of the symbol on the instance (standalone or before mount / after unmount) means “no runtime”.
 */
export const SCHEDULE_UPDATE_HOOK = Symbol('effectable:schedule_update_hook');

/**
 * Internal contract for a component that intercepts `props` updates from GraphRuntime.
 *
 * Not part of the public API for user components; intended for infrastructure HOCs.
 */
export interface RuntimePropsReceiver<P = unknown> {
  [RUNTIME_PROPS_RECEIVER]?(props: P): void;
}

/**
 * Explicit Resource Management (ECMAScript) contract.
 * Implementation allows using the instance in `using` for a guaranteed dispose call on block exit.
 */
export interface Disposable {
  [Symbol.dispose](): void;
}

// ---------------------------------------------------------------------------
// Declarative component tree
// ---------------------------------------------------------------------------

/**
 * Typed ref object for accessing a component instance from a parent.
 * Filled by GraphRuntime when the node mounts.
 */
export interface RefObject<T> {
  /** Current component instance (null before mount or after unmount). */
  current: T | null;
}

/**
 * Typed component constructor.
 */
export type ComponentConstructor<P = unknown> = new (props: P) => Component<unknown, P>;

/**
 * Virtual service-tree node — a declarative component description for GraphRuntime.
 * Created by h() and never contains side effects.
 *
 * To store heterogeneous nodes in arrays (compose() result, children)
 * use AnyVirtualServiceNode (without a generic).
 */
export interface VirtualServiceNode<P = unknown> {
  /**
   * Component class that GraphRuntime will instantiate.
   * Stored as an unknown constructor for covariant compatibility when held
   * in arrays and runtime structures. GraphRuntime uses vnode.props to create the instance.
   */
  type: ComponentConstructor<unknown>;
  /** Props passed to the component constructor. */
  props: P;
  /**
   * Stable identity key for diffing.
   * Required in dynamic lists — without a key the reconciler cannot correctly reuse nodes.
   */
  key?: string;
  /** Ref for accessing the instance from the parent component. */
  ref?: RefObject<unknown>;
  /** Child nodes in declaration order. */
  children: VirtualServiceNode[];
}

/**
 * Node lifecycle status within GraphRuntime.
 * Transitions are strictly unidirectional (except the ready -> update pass -> ready loop).
 *
 * registered -> resolved -> created -> mounted -> ready
 * ready -(props/state/context change)-> update pass -> ready
 * ready -> unmounting -> unmounted -> destroyed
 * any stage -> failed (no return)
 */
export type NodeLifecycleStatus =
  | 'registered'
  | 'resolved'
  | 'created'
  | 'mounted'
  | 'ready'
  | 'unmounting'
  | 'unmounted'
  | 'destroyed'
  | 'failed';

/**
 * Named fiber effect tags for the reconciler commit phase.
 * null (no tag) is not part of the object — see {@link FiberEffectTag}.
 */
export const FIBER_EFFECT_TAG = {
  /** New node (PLACE). */
  PLACE: 'PLACE',
  /** Props update (UPDATE). */
  UPDATE: 'UPDATE',
  /** Node removal (DELETE). */
  DELETE: 'DELETE',
} as const;

/**
 * Fiber effect tag: a value from {@link FIBER_EFFECT_TAG} or `null`.
 *
 * NOTE: `null` means no uncommitted effect on the fiber. Currently set only after
 * a successful PLACE/materialize: when `runStartup` completes ok (sync materialize path,
 * `continueMaterializeAsync`, `finalizeMaterializeAsync`), GraphRuntime resets
 * `effectTag` from {@link FIBER_EFFECT_TAG.PLACE} to `null` before `injectUpdateHook`.
 *
 * Do not confuse with “node was never updated”: after {@link FIBER_EFFECT_TAG.UPDATE}
 * (`applyFiberUpdate`) the tag remains `UPDATE` and is not reset back to `null`.
 * For DELETE there is no separate assignment on the fiber in the current GraphRuntime —
 * removal goes through `destroyFiber` without writing `effectTag = DELETE`.
 */
export type FiberEffectTag =
  | (typeof FIBER_EFFECT_TAG)[keyof typeof FIBER_EFFECT_TAG]
  | null;

/**
 * Readonly snapshot of a fiber node for test/debug introspection ({@link GraphRuntime.inspectRootFiber}).
 * Does not contain mutable references to RuntimeFiber / instance / engine.
 */
export type FiberInspectNode = {
  /** Current effectTag after the last materialize/reconcile phase. */
  effectTag: FiberEffectTag;
  /** true if the fiber has a materialized instance. */
  hasInstance: boolean;
  /** Virtual node key (null if unset). */
  key: string | null;
  /** Number of direct child fibers. */
  childCount: number;
  /** Recursive readonly child snapshots (compose order). */
  children: readonly FiberInspectNode[];
};

/**
 * Fiber — the reconciler work unit.
 * Each virtual tree node has a corresponding fiber in the current tree.
 * During reconcile a work-in-progress (WIP) tree is built via the alternate field.
 */
export interface Fiber<P = unknown> {
  /** Virtual node this fiber was created from. */
  vnode: VirtualServiceNode<P>;
  /** Real component instance (null before the created phase). */
  instance: Component<unknown, P> | null;
  /** Current node lifecycle status. */
  lifecycleStatus: NodeLifecycleStatus;
  /** Child fibers in declaration order. */
  children: Fiber[];
  /** Parent fiber (null for the root). */
  parentFiber: Fiber | null;
  /**
   * Alternate fiber — WIP pair of the current node during reconcile.
   * current.alternate == wip, wip.alternate == current.
   */
  alternate: Fiber | null;
  /** Pending props for a node update (null — no pending update). */
  pendingProps: P | null;
  /** Effect tag for the commit phase. */
  effectTag: FiberEffectTag;
}
