/**
 * GraphRuntime — runtime engine for materialization, reconcile, and lifecycle of a component tree.
 *
 * Responsibilities:
 * - Materialize a VirtualServiceNode tree into real component instances (Fiber tree).
 * - Fiber-like reconcile: diff current vs next trees by key + type, assign effectTags.
 *   Reconciliation mutates the live graph (not an isolated work-in-progress tree).
 * - Drive lifecycle via LifecycleEngine: startup in topological order (children before parent),
 *   shutdown in the same order (children before parent).
 * - Inject contexts (@UseContext) and bind refs on mount.
 * - Pass updated props into existing instances during reconcile.
 * - Serialize all graph operations through a single operation queue.
 *
 * Fail-safe contracts (public behavior):
 * - Unrecoverable reconcile / dirty-flush errors **fail-stop**: mark runtime FAILED, tear the
 *   tree down children→parent, reject later `reconcile`. `onAutoReconcileError` is best-effort
 *   observability — a throwing observer cannot skip fail-stop.
 * - Dirty flush runs only while ACTIVE and the operation queue is idle; `setState` during child
 *   materialization is buffered and applied after the mount/reconcile pass.
 * - UPDATE `commitRef` runs after successful compose and *before* child reconcile so
 *   same-pass PLACE `onMount` observes parent `nextRef` (mount path already commits before
 *   deferred onMount flush). Child-reconcile failure rolls the early commit back; compose
 *   failure never touches refs.
 * - Failed cleanup is children-first and does not invoke a phantom parent `onUnmount`.
 * - Orphan DELETE finalize is best-effort so survivors are not fail-stopped for cleanup noise.
 *
 * Current limitations:
 * - Work loop is synchronous (no priority lanes — next increment).
 * - Component.setState() and connect selector updates schedule automatic subtree reconcile
 *   via a dirty-fiber queue with microtask coalescing; manual reconcile remains a force-update API.
 * - ContextProvider is handled as a special case in buildScope.
 *
 * @module Effectable/component/GraphRuntime
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { Component } from './Component';
import type {
  Fiber,
  FiberEffectTag,
  FiberInspectNode,
  RefObject,
  RuntimePropsReceiver,
  VirtualServiceNode,
} from './types';
import {
  CONNECT_REBIND_LIFECYCLE,
  FIBER_EFFECT_TAG,
  RUNTIME_PROPS_RECEIVER,
  SCHEDULE_UPDATE_HOOK,
} from './types';
import { LifecycleEngine } from './lifecycle';
import {
  ContextProvider,
  EMPTY_CONTEXT_SCOPE,
  injectContextFields,
  IS_CONTEXT_PROVIDER,
} from './context';
import type { ContextScope } from './context';
import { getImperativeHandleMethods } from './refs';
import type {
  RuntimeCommand,
  RuntimeEvent,
  RuntimeQuery,
} from '../runtime/types';
import type { RuntimeBusesBundle } from '../runtime/BusDecorators';
import {
  releaseExclusiveRuntimeBusHandlers,
  wireRuntimeBusesIfDecorated,
} from '../runtime/BusDecorators';
import { GRAPH_RUNTIME_MAX_DIRTY_FLUSH_PASSES } from './graphRuntime.constants';

/**
 * Checks whether a value is thenable (Promise-like).
 * Key to GraphRuntime sync fast-path: `materialize`/`reconcileFiber`/`destroyFiber`
 * return union `T | Promise<T>`; the caller routes via this helper
 * (116x / 266x on pure sync trees).
 *
 * @param {unknown} value - value under test
 * @returns {boolean}
 */
function isThenable<T> (value: T | PromiseLike<T>): value is PromiseLike<T> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

// ---------------------------------------------------------------------------
// Runtime state machine
// ---------------------------------------------------------------------------

/**
 * Runtime state literals.
 * Private to GraphRuntime; reduced set without mounting/reconciling.
 */
const RUNTIME_STATE = {
  IDLE: 'idle',
  ACTIVE: 'active',
  FAILED: 'failed',
  UNMOUNTING: 'unmounting',
  UNMOUNTED: 'unmounted',
} as const;

/**
 * Runtime state type derived from RUNTIME_STATE.
 * Not exported from package index (internal diagnostic only).
 */
type RuntimeState = (typeof RUNTIME_STATE)[keyof typeof RUNTIME_STATE];

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

/**
 * Construction journal: tracks resources acquired during fiber materialization.
 * On failure, resources are released in reverse acquisition order.
 */
interface FiberConstructionJournal {
  /** Scheduler hook injection step completed. */
  schedulerHookAttached?: boolean;
  /** Runtime bus wiring step completed. */
  busWiringAttached?: boolean;
  /** Ref binding step completed. */
  refBound?: boolean;
  /**
   * Structure + bus wiring finished, but {@link LifecycleEngine.runStartup} was deferred.
   * Cleared when {@link GraphRuntime.flushDeferredLifecycleTree} runs startup.
   *
   * Used so sibling (and parent) `@On*` handlers are subscribed before any peer
   * `onMount` publishes — depth-first materialize otherwise drops those events.
   */
  lifecycleDeferred?: boolean;
  /** Successfully mounted child fibers (in acquisition order). */
  mountedChildren: RuntimeFiber<unknown>[];
  /** Original ref owner (for identity-safe clearing during rollback). */
  refOwner?: Component<unknown, unknown>;
  /** Rollback already invoked (idempotency guard). */
  rolledBack?: boolean;
}

/**
 * Internal extended fiber with lifecycle-engine and scope.
 */
interface RuntimeFiber<P = unknown> extends Fiber<P> {
  /** Lifecycle state machine for this node. */
  engine: LifecycleEngine;
  /** Context scope inherited from the parent and extended by ContextProvider. */
  scope: ContextScope;
  /**
   * Disposer for auto-wiring {@link wireRuntimeBusesIfDecorated} for `@Use*Bus` / `@On*` decorators.
   * Called after `runShutdown` (after `onUnmount`).
   */
  effectableRuntimeBusDisposer?: () => void;
  /**
   * `setState` during `runStartup`/`onMount` happened before the live
   * {@link SCHEDULE_UPDATE_HOOK} was injected: after startup, {@link scheduleUpdate} must run.
   */
  pendingScheduleUpdate?: boolean;
  /**
   * Construction journal: records acquired resources during materialization.
   * Used for transactional rollback on failure.
   */
  constructionJournal?: FiberConstructionJournal;
  /**
   * When set, `onUpdate(prevProps, props)` was deferred during a sibling reconcile
   * batch (`deferLifecycle`) so later PLACE/REPLACE peers can finish `@On*` bus
   * wiring first. Cleared by {@link GraphRuntime.flushPendingOnUpdateTree}.
   */
  pendingOnUpdatePrevProps?: unknown;
  /** True when {@link pendingOnUpdatePrevProps} holds a deferred onUpdate. */
  hasPendingOnUpdate?: boolean;
}

// ---------------------------------------------------------------------------
// GraphRuntime
// ---------------------------------------------------------------------------

/**
 * Runtime engine for a declarative component tree.
 *
 * After fail-stop the instance is terminal (`FAILED`): further `reconcile` rejects;
 * `unmount` remains safe. See the module overview for the fail-safe contracts.
 *
 * Usage:
 * ```typescript
 * const runtime = await GraphRuntime.mount(h(AppRoot));
 * await runtime.reconcile(h(AppRoot, { newProp: 1 }));
 * await runtime.unmount();
 * ```
 */
export class GraphRuntime {
  /** Current root fiber tree (current tree). */
  private currentRoot: RuntimeFiber | null = null;
  /**
   * Entry counter for {@link continueStableReconcileAsync} (test/debug probe).
   * Not reset automatically — compare before/after around reconcile.
   */
  private stableAsyncContinueCount = 0;

  /**
   * Backing field for {@link GraphRuntime.state}. Writes and most reads go
   * through the accessor; post-await re-reads use `_state` (TS 6 still narrows getters).
   */
  private _state: RuntimeState = RUNTIME_STATE.IDLE;

  /**
   * Runtime state machine.
   * IDLE → ACTIVE (on mount) → FAILED | UNMOUNTING → UNMOUNTED.
   * FAILED is terminal: subsequent reconcile rejects, unmount is safe.
   */
  private get state (): RuntimeState {
    return this._state;
  }

  private set state (next: RuntimeState) {
    this._state = next;
  }

  /**
   * Terminal error captured by failStop().
   * Stored to reject later reconcile calls with the same error.
   */
  private terminalError: Error | null = null;

  /**
   * Runtime buses for auto-wiring decorators on nodes (optional, set in {@link GraphRuntime.mount}).
   */
  private effectableRuntimeBuses: RuntimeBusesBundle<
    RuntimeCommand,
    RuntimeQuery,
    RuntimeEvent
  > | null = null;

  /**
   * Depth-indexed pool of Map objects for keyedCurrentMap in reconcileChildren.
   * Index is recursion depth, which provides re-entrancy safety for nested calls.
   * Map.clear() instead of new Map() yields 5.1x speedup.
   */
  private readonly keyedMapPool: Map<string, RuntimeFiber<unknown>>[] = [];

  /**
   * Current reconcileChildren recursion depth.
   * Incremented before async work, decremented in finally.
   */
  private reconcileDepth = 0;

  /**
   * Set of fiber nodes whose `compose()` subtrees need rebuild.
   * Holds only a “minimal cover”: if an ancestor is already in the set, a descendant is not added.
   */
  private readonly dirtyFibers: Set<RuntimeFiber<unknown>> = new Set();

  /** `true` — a microtask flush is already queued. */
  private flushScheduled = false;

  /** `true` — automatic dirty-fiber flush is in progress (re-entrancy guard). */
  private flushing = false;

  /**
   * Promise of the current/scheduled dirty-flush (microtask).
   * Manual `reconcile` awaits it to avoid overlapping an in-flight flush.
   */
  private activeFlush: Promise<void> | null = null;

  /**
   * Number of consecutive dirty-flush passes in the current microtask chain.
   * Reset when the queue is empty after a pass or on manual `reconcile`.
   */
  private dirtyFlushPassCount = 0;

  /**
   * Optional hook invoked when automatic reconcile (dirty-fiber flush) fails.
   * Set via the fourth argument of {@link GraphRuntime.mount}.
   */
  private onAutoReconcileError: ((err: unknown) => void) | null = null;

  /**
   * Operation queue: serializes reconcile and unmount.
   * Each operation is a Promise-returning function executed sequentially.
   */
  private operationQueue: Array<() => Promise<void>> = [];

  /**
   * Whether an operation is currently running.
   */
  private operationInProgress = false;

  /**
   * Async context bound for the currently executing queued graph operation.
   * Distinguishes true reentrancy (onMount/onUpdate → reconcile/unmount on the same
   * async chain) from concurrent external callers that must only enqueue.
   * Awaiting a nested queue entry from inside the running op deadlocks the queue.
   */
  private readonly operationAsyncContext = new AsyncLocalStorage<true>();

  /**
   * Cached unmount promise for concurrent unmount callers.
   */
  private cachedUnmountPromise: Promise<void> | null = null;

  /**
   * Pending fail-stop teardown work.
   * When failStop nulls currentRoot but destroy is async, this tracks the in-flight cleanup.
   * unmount() must await this before concluding teardown is finished.
   */
  private pendingTeardown: Promise<void> | null = null;

  /**
   * Imperative ref values bound for owners that expose `@UseImperativeHandle` methods.
   * `commitRef` assigns a limited handle (not the Component instance) into `ref.current`;
   * identity-safe clear must still recognize that handle as owned by the instance.
   */
  private readonly imperativeRefByOwner: WeakMap<
    Component<unknown, unknown>,
    object
  > = new WeakMap();

  /**
   * Instances are created only via {@link GraphRuntime.mount}; direct `new GraphRuntime()` is unavailable externally.
   */
  private constructor () {}

  /**
   * Fail-stop: mark the runtime as failed, disable scheduling, tear down the graph best-effort.
   * After fail-stop:
   * - state is FAILED
   * - terminalError is set
   * - currentRoot is null (even if destroyFiber throws)
   * - later reconcile() rejects with the terminal error
   * - unmount() is safe and joinable
   *
   * No failed reconcile leaves the runtime active with a partial graph.
   * Primary-error rules: cleanup errors attached as rollbackErrors, never replace primary.
   *
   * @param {Error} error - unrecoverable error that triggered fail-stop
   * @returns {void | Promise<void>}
   */
  private failStop (error: Error): void | Promise<void> {
    // Idempotent: if already failed, skip
    if (this.state === RUNTIME_STATE.FAILED || this.state === RUNTIME_STATE.UNMOUNTED) {
      return;
    }

    this.state = RUNTIME_STATE.FAILED;
    this.terminalError = error;

    // Disable scheduling immediately
    this.dirtyFibers.clear();
    this.flushScheduled = false;

    // Best-effort teardown of the current/partial graph
    // MUST set currentRoot = null even if destroyFiber throws
    if (this.currentRoot !== null) {
      const root = this.currentRoot;
      this.currentRoot = null;
      
      // Collect cleanup errors during fail-stop (attach as rollbackErrors)
      const cleanupErrors: Error[] = [];
      const destroyRes = this.destroyFiber(root, cleanupErrors);
      
      if (isThenable(destroyRes)) {
        // Async path: track pending teardown so unmount() can join
        this.pendingTeardown = destroyRes
          .then(() => {
            if (cleanupErrors.length > 0) {
              (error as Error & { rollbackErrors?: Error[] }).rollbackErrors = cleanupErrors;
            }
          })
          .finally(() => {
            this.pendingTeardown = null;
          });
        return this.pendingTeardown;
      }
      
      // Sync path: attach cleanup errors immediately
      if (cleanupErrors.length > 0) {
        (error as Error & { rollbackErrors?: Error[] }).rollbackErrors = cleanupErrors;
      }
    }
  }

  /**
   * Auto-wires runtime-bus decorators onto the instance before {@link LifecycleEngine.runStartup}.
   *
   * @template P
   * @param {Component<unknown, P>} instance - node instance
   * @param {RuntimeFiber<P>} fiber - node fiber (stores disposer)
   * @returns {void}
   */
  private attachEffectableRuntimeBusWiring<P> (
    instance: Component<unknown, P>,
    fiber: RuntimeFiber<P>,
  ): void {
    if (this.effectableRuntimeBuses === null) {
      return;
    }

    const disposer = wireRuntimeBusesIfDecorated(instance, this.effectableRuntimeBuses);
    if (disposer !== null) {
      fiber.effectableRuntimeBusDisposer = disposer;
    }
  }

  /**
   * Removes runtime-bus registrations created by {@link attachEffectableRuntimeBusWiring}.
   *
   * @param {RuntimeFiber<unknown>} fiber - node fiber
   * @returns {void}
   */
  private disposeEffectableRuntimeBusWiring (fiber: RuntimeFiber<unknown>): void {
    const disposer = fiber.effectableRuntimeBusDisposer;
    if (typeof disposer === 'function') {
      disposer();
    }

    delete fiber.effectableRuntimeBusDisposer;
  }

  /**
   * Releases exclusive Command/Query registrations for `fiber` and every mounted
   * descendant. Root-only release is not enough when `@OnCommand` / `@OnQuery` live
   * on nested children under a keyed wrapper that is about to be orphaned.
   * EventBus subscriptions are left intact (see exclusive pre-PLACE release below).
   *
   * @param {RuntimeFiber<unknown>} fiber - orphan root (or any subtree root)
   * @param {RuntimeBusesBundle<RuntimeCommand, RuntimeQuery, RuntimeEvent>} buses - runtime buses
   * @returns {void}
   */
  private releaseExclusiveRuntimeBusHandlersSubtree (
    fiber: RuntimeFiber<unknown>,
    buses: NonNullable<GraphRuntime['effectableRuntimeBuses']>,
  ): void {
    const children = fiber.children;
    for (let i = 0; i < children.length; i += 1) {
      const child = children[i];
      if (child !== undefined) {
        this.releaseExclusiveRuntimeBusHandlersSubtree(
          child as RuntimeFiber<unknown>,
          buses,
        );
      }
    }
    const instance = fiber.instance;
    if (instance !== null) {
      releaseExclusiveRuntimeBusHandlers(instance, buses);
    }
  }

  /**
   * Fibers that will be unpaired after the next-child match (full-diff orphans).
   * Pure: mirrors keyed/unkeyed matching without materializing or destroying.
   *
   * @param {RuntimeFiber<unknown>[]} currentChildren - current child fibers
   * @param {VirtualServiceNode[]} nextVnodes - next child vnodes
   * @param {boolean} hasKeyedCurrent - whether any current child has a key
   * @returns {RuntimeFiber<unknown>[]} fibers that will be destroyed as orphans
   */
  private collectFullDiffOrphans (
    currentChildren: RuntimeFiber<unknown>[],
    nextVnodes: VirtualServiceNode[],
    hasKeyedCurrent: boolean,
  ): RuntimeFiber<unknown>[] {
    const orphans: RuntimeFiber<unknown>[] = [];
    const unkeyedCurrent: RuntimeFiber<unknown>[] = [];
    let unkeyedIdx = 0;

    if (hasKeyedCurrent) {
      const keyedCurrentMap = new Map<string | number, RuntimeFiber<unknown>>();
      for (const child of currentChildren) {
        const key = child.vnode.key;
        if (key !== undefined) {
          keyedCurrentMap.set(key, child);
        } else {
          unkeyedCurrent.push(child);
        }
      }

      for (const nextVnode of nextVnodes) {
        const nextKey = nextVnode.key;
        if (nextKey !== undefined && keyedCurrentMap.has(nextKey)) {
          keyedCurrentMap.delete(nextKey);
        } else if (nextKey === undefined && unkeyedIdx < unkeyedCurrent.length) {
          unkeyedIdx += 1;
        }
      }

      for (const [, orphan] of keyedCurrentMap) {
        orphans.push(orphan);
      }
    } else {
      for (const child of currentChildren) {
        unkeyedCurrent.push(child);
      }
      unkeyedIdx = Math.min(nextVnodes.length, unkeyedCurrent.length);
    }

    for (let i = unkeyedIdx; i < unkeyedCurrent.length; i += 1) {
      const orphan = unkeyedCurrent[i];
      if (orphan !== undefined) {
        orphans.push(orphan);
      }
    }

    return orphans;
  }

  /**
   * Builds the value assigned to `ref.current` for a mounted instance.
   *
   * When the constructor declares `@UseImperativeHandle` methods, only those methods
   * are exposed (bound to the instance) — matching the refs.ts / CONCEPT contract.
   * Without an allowlist, the full instance is assigned (legacy escape hatch).
   *
   * @param {Component<unknown, unknown>} instance - mounted component instance
   * @returns {unknown} instance or limited imperative handle object
   */
  private resolveRefCurrentValue (instance: Component<unknown, unknown>): unknown {
    const methods = getImperativeHandleMethods(
      instance.constructor as unknown as Parameters<typeof getImperativeHandleMethods>[0],
    );

    if (methods.length === 0) {
      this.imperativeRefByOwner.delete(instance);
      return instance;
    }

    const handle: Record<string | symbol, unknown> = Object.create(null) as Record<
      string | symbol,
      unknown
    >;

    for (const { methodKey } of methods) {
      const fn = (instance as unknown as Record<string | symbol, unknown>)[methodKey];
      if (typeof fn !== 'function') {
        throw new Error(
          `[Effectable.GraphRuntime] @UseImperativeHandle method is not a function: ${String(methodKey)}`,
        );
      }
      handle[methodKey] = (fn as (...args: unknown[]) => unknown).bind(instance);
    }

    this.imperativeRefByOwner.set(instance, handle);
    return handle;
  }

  /**
   * Identity-safe ref clearing: clears ref.current only if it still points to the expected owner
   * (full instance) or the limited imperative handle previously bound for that owner.
   * Prevents an old rollback from clearing a ref that a newer materialization already reused.
   *
   * @param {RefObject<unknown>} ref - ref object
   * @param {Component<unknown, unknown>} expectedOwner - expected current owner
   * @returns {void}
   */
  private clearRefSafe (ref: RefObject<unknown>, expectedOwner: Component<unknown, unknown>): void {
    const boundHandle = this.imperativeRefByOwner.get(expectedOwner);
    if (ref.current === expectedOwner || (boundHandle !== undefined && ref.current === boundHandle)) {
      ref.current = null;
    }
    this.imperativeRefByOwner.delete(expectedOwner);
  }

  /**
   * Centralized ref ownership transition.
   * Handles every ref binding/clearing operation: add, remove, replace.
   * 
   * Rules:
   * - Clear previousRef only if it still points to expectedPreviousOwner (identity-safe).
   * - Bind nextRef to the instance, or to a limited `@UseImperativeHandle` surface when declared.
   * - previousRef and nextRef can be the same object (ref reuse) or different (ref swap).
   * - Do not let an old disposer clear a newer owner.
   * 
   * @param {RefObject<unknown> | undefined} previousRef - ref to clear (can be undefined if no previous ref)
   * @param {Component<unknown, unknown> | null} expectedPreviousOwner - expected owner of previousRef (null if unknown)
   * @param {RefObject<unknown> | undefined} nextRef - ref to bind to instance (can be undefined if removing ref)
   * @param {Component<unknown, unknown> | null} instance - instance to bind nextRef to (null when clearing only)
   * @returns {void}
   */
  private commitRef (
    previousRef: RefObject<unknown> | undefined,
    expectedPreviousOwner: Component<unknown, unknown> | null,
    nextRef: RefObject<unknown> | undefined,
    instance: Component<unknown, unknown> | null,
  ): void {
    // Clear previous ref if it's different from next (ref swap) or if next is undefined (ref removal)
    if (previousRef !== undefined && previousRef !== nextRef && expectedPreviousOwner !== null) {
      this.clearRefSafe(previousRef, expectedPreviousOwner);
    }
    // Bind next ref: limited handle when @UseImperativeHandle is present, else full instance.
    // Custom setters may assign `current` then throw. Without a catch, UPDATE ref-swap
    // leaves the new ref holding the instance/handle while `fiber.vnode.ref` still points at
    // the previous ref object — fail-stop finalize clears only the old ref (zombie nextRef).
    // Materialize assign-then-throw is covered by journal.refBound (#96/#98); this path covers
    // the UPDATE swap hole and is a safe no-op when the setter never assigned.
    if (nextRef !== undefined) {
      try {
        nextRef.current = instance === null ? null : this.resolveRefCurrentValue(instance);
      } catch (error: unknown) {
        if (instance !== null) {
          try {
            this.clearRefSafe(nextRef, instance);
          } catch {
            // Best-effort: do not mask the original setter error.
          }
        }
        throw error;
      }
    }
  }

  /**
   * Finalize fiber destroy: dispose wiring, clear ref, update status.
   * Collects errors when collectErrors is provided (best-effort cleanup).
   * When collectErrors is null, errors are thrown immediately.
   * 
   * Uses commitRef for identity-safe ref clearing.
   *
   * @param {RuntimeFiber<unknown>} fiber - fiber being finalized
   * @param {Error[] | null} collectErrors - array to collect errors (null to throw)
   * @returns {void}
   */
  private finalizeFiberDestroy (fiber: RuntimeFiber<unknown>, collectErrors: Error[] | null): void {
    // Dispose runtime bus wiring
    if (collectErrors !== null) {
      try {
        this.disposeEffectableRuntimeBusWiring(fiber);
      } catch (err: unknown) {
        collectErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    } else {
      this.disposeEffectableRuntimeBusWiring(fiber);
    }

    // Clear ref via commitRef (identity-safe clearing)
    const ref = fiber.vnode.ref;
    const instance = fiber.instance;
    if (ref !== undefined && instance !== null) {
      if (collectErrors !== null) {
        try {
          this.commitRef(ref, instance, undefined, null);
        } catch (err: unknown) {
          collectErrors.push(err instanceof Error ? err : new Error(String(err)));
        }
      } else {
        this.commitRef(ref, instance, undefined, null);
      }
    }

    // Update lifecycle status
    fiber.lifecycleStatus = fiber.engine.getStatus();
  }

  /**
   * Transactional rollback for failed fiber materialization.
   * Releases acquired resources in reverse acquisition order:
   * 1. disable scheduler hook
   * 2. destroy mounted children in compose order (same as {@link destroyFiber})
   * 3. run failed-startup cleanup (parent onUnmount when startup ran)
   * 4. dispose runtime bus registrations
   * 5. clear bound ref (identity-safe)
   * 6. unlink the partial fiber
   *
   * Children must be destroyed before parent bus dispose / ref clear / onUnmount so
   * child onUnmount still sees a live parent ref and parent @On* subscriptions
   * (matches {@link destroyFiber} / {@link runFiberFailedCleanup}).
   *
   * Cleanup is best-effort: one failure does not skip remaining steps.
   * Preserves the original materialization error; cleanup errors are attached.
   * Rollback is idempotent.
   *
   * @param {RuntimeFiber<P>} fiber - fiber being rolled back
   * @param {Error} primaryError - original materialization/startup error
   * @returns {void | Promise<void>}
   */
  private rollbackFailedMaterialization<P> (
    fiber: RuntimeFiber<P>,
    primaryError: Error,
  ): void | Promise<void> {
    const journal = fiber.constructionJournal;
    if (journal === undefined || journal.rolledBack === true) {
      return;
    }
    journal.rolledBack = true;

    const cleanupErrors: Error[] = [];
    const instance = fiber.instance;

    // 1. Disable scheduler hook (pre-mount buffer may be attached before children,
    // before journal.schedulerHookAttached is set after successful startup).
    if (instance !== null) {
      try {
        this.clearUpdateHook(instance);
        this.dirtyFibers.delete(fiber);
      } catch (err: unknown) {
        cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // 2. Destroy mounted children in compose order BEFORE parent onUnmount / bus / ref.
    // Documented teardown contract is children → parent with siblings in compose
    // order (matches destroyFiber / README shutdown). Reverse sibling order made
    // failure-path onUnmount observe a different live-sibling set than clean unmount.
    // Children must also run before bus dispose + ref clear so child onUnmount still
    // sees a live parent ref / parent @On* subscriptions.
    // Pass cleanupErrors so nested destroy is best-effort: a throwing
    // ref-clear/disposer on one grandchild must not skip remaining siblings.
    // Those nodes were never attached to currentRoot, so failStop cannot reclaim them.
    const destroyChildrenThenParentCleanup = (): void | Promise<void> => {
      const children = journal.mountedChildren;
      for (let i = 0; i < children.length; i += 1) {
        try {
          const destroyRes = this.destroyFiber(children[i] as RuntimeFiber<unknown>, cleanupErrors);
          if (isThenable(destroyRes)) {
            return this.continueRollbackDestroyAsync(
              children,
              i,
              destroyRes,
              primaryError,
              cleanupErrors,
              fiber as RuntimeFiber<unknown>,
              instance,
            );
          }
        } catch (err) {
          cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }

      return this.finishRollbackParentCleanup(fiber, instance, primaryError, cleanupErrors);
    };

    return destroyChildrenThenParentCleanup();
  }

  /**
   * Async continuation of rollback child destruction after one child's destroy returned a Promise.
   *
   * @param {RuntimeFiber<unknown>[]} children - mounted children
   * @param {number} pendingIdx - index of the child whose destroy is pending
   * @param {Promise<void>} pending - Promise from destroying the previous child
   * @param {Error} primaryError - original materialization error
   * @param {Error[]} cleanupErrors - accumulated cleanup errors
   * @param {RuntimeFiber<unknown>} fiber - parent fiber being rolled back
   * @param {Component<unknown, unknown> | null} instance - parent instance (for post-child cleanup)
   * @returns {Promise<void>}
   */
  private async continueRollbackDestroyAsync (
    children: RuntimeFiber<unknown>[],
    pendingIdx: number,
    pending: Promise<void>,
    primaryError: Error,
    cleanupErrors: Error[],
    fiber: RuntimeFiber<unknown>,
    instance: Component<unknown, unknown> | null,
  ): Promise<void> {
    try {
      await pending;
    } catch (err) {
      cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
    }

    // Remaining siblings in compose order (pendingIdx+1 … n-1), matching destroyFiber.
    for (let i = pendingIdx + 1; i < children.length; i += 1) {
      try {
        const destroyRes = this.destroyFiber(children[i] as RuntimeFiber<unknown>, cleanupErrors);
        if (isThenable(destroyRes)) {
          await destroyRes;
        }
      } catch (err: unknown) {
        cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    const cleanupRes = this.finishRollbackParentCleanup(
      fiber,
      instance,
      primaryError,
      cleanupErrors,
    );
    if (isThenable(cleanupRes)) {
      await cleanupRes;
    }
  }

  /**
   * After rollback destroyed children: run parent failed-cleanup only when startup
   * actually ran (`status !== 'registered'`), then dispose parent bus + clear parent
   * ref (after children / onUnmount), then attach cleanup errors and rethrow.
   *
   * @param {RuntimeFiber<unknown>} fiber - parent fiber being rolled back
   * @param {Component<unknown, unknown> | null} instance - parent instance
   * @param {Error} primaryError - original materialization error
   * @param {Error[]} cleanupErrors - accumulated cleanup errors
   * @returns {void | Promise<void>} always rejects via {@link finalizeRollback}
   */
  private finishRollbackParentCleanup (
    fiber: RuntimeFiber<unknown>,
    instance: Component<unknown, unknown> | null,
    primaryError: Error,
    cleanupErrors: Error[],
  ): void | Promise<void> {
    if (instance !== null) {
      // `registered` ⇒ runStartup never entered; do not invent an onUnmount.
      // `failed` (deferFailedCleanup) / other post-startup statuses ⇒ wasMounted.
      const wasMounted = fiber.engine.getStatus() !== 'registered';
      if (wasMounted) {
        try {
          const cleanupRes = fiber.engine.runFailedCleanup(instance, true);
          if (isThenable(cleanupRes)) {
            return cleanupRes.then(
              () => {
                this.disposeRollbackParentResources(fiber, cleanupErrors);
                fiber.lifecycleStatus = fiber.engine.getStatus();
                this.finalizeRollback(primaryError, cleanupErrors);
              },
              (err: unknown) => {
                cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
                this.disposeRollbackParentResources(fiber, cleanupErrors);
                fiber.lifecycleStatus = fiber.engine.getStatus();
                this.finalizeRollback(primaryError, cleanupErrors);
              },
            );
          }
        } catch (err: unknown) {
          cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }
      this.disposeRollbackParentResources(fiber, cleanupErrors);
      fiber.lifecycleStatus = fiber.engine.getStatus();
    } else {
      this.disposeRollbackParentResources(fiber, cleanupErrors);
    }

    this.finalizeRollback(primaryError, cleanupErrors);
  }

  /**
   * Best-effort parent bus dispose + identity-safe ref clear after children (and
   * parent onUnmount when applicable) have finished during materialize rollback.
   *
   * @param {RuntimeFiber<unknown>} fiber - parent fiber being rolled back
   * @param {Error[]} cleanupErrors - accumulated cleanup errors
   * @returns {void}
   */
  private disposeRollbackParentResources (
    fiber: RuntimeFiber<unknown>,
    cleanupErrors: Error[],
  ): void {
    const journal = fiber.constructionJournal;
    if (journal === undefined) {
      return;
    }

    if (journal.busWiringAttached === true) {
      try {
        this.disposeEffectableRuntimeBusWiring(fiber);
      } catch (err: unknown) {
        cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
      journal.busWiringAttached = false;
    }

    if (journal.refBound === true && fiber.vnode.ref !== undefined && journal.refOwner !== undefined) {
      try {
        this.commitRef(fiber.vnode.ref, journal.refOwner, undefined, null);
      } catch (err: unknown) {
        cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
      journal.refBound = false;
    }
  }

  /**
   * Attaches cleanup errors to the primary error and rethrows.
   *
   * @param {Error} primaryError - original materialization error
   * @param {Error[]} cleanupErrors - cleanup errors
   * @returns {never}
   */
  private finalizeRollback (primaryError: Error, cleanupErrors: Error[]): never {
    if (cleanupErrors.length > 0) {
      (primaryError as Error & { rollbackErrors?: Error[] }).rollbackErrors = cleanupErrors;
    }
    throw primaryError;
  }

  /**
   * Injects the scheduler hook onto the component instance after successful startup.
   * The hook is called from {@link Component.setState} and enqueues the fiber for automatic reconcile.
   *
   * If `setState` ran during startup (pre-mount buffer), schedules reconcile immediately.
   *
   * @param {Component<unknown, unknown>} instance - mounted instance
   * @param {RuntimeFiber<unknown>} fiber - instance fiber (captured in the closure)
   * @returns {void}
   */
  private injectUpdateHook (instance: Component<unknown, unknown>, fiber: RuntimeFiber<unknown>): void {
    (instance as unknown as Record<symbol, unknown>)[SCHEDULE_UPDATE_HOOK] = (): void => {
      this.scheduleUpdate(fiber);
    };

    if (fiber.pendingScheduleUpdate === true) {
      fiber.pendingScheduleUpdate = false;
      this.scheduleUpdate(fiber);
    }
  }

  /**
   * Pre-mount buffer: `setState` cannot yet schedule reconcile (the live hook is
   * injected after startup). Marks the fiber; {@link injectUpdateHook} after
   * startup will call {@link scheduleUpdate} (deferred until the mount pass completes).
   *
   * Injected before child materialization so descendant `onMount` callbacks that
   * `setState` an ancestor are buffered instead of silently dropped.
   *
   * @param {Component<unknown, unknown>} instance - instance before/during startup
   * @param {RuntimeFiber<unknown>} fiber - instance fiber
   * @returns {void}
   */
  private injectPreMountUpdateHook (
    instance: Component<unknown, unknown>,
    fiber: RuntimeFiber<unknown>,
  ): void {
    fiber.pendingScheduleUpdate = false;
    (instance as unknown as Record<symbol, unknown>)[SCHEDULE_UPDATE_HOOK] = (): void => {
      fiber.pendingScheduleUpdate = true;
    };
  }

  /**
   * Removes the scheduler hook from the instance before unmount.
   * After removal, `setState()` no longer triggers automatic reconcile.
   *
   * @param {Component<unknown, unknown>} instance - instance being unmounted
   * @returns {void}
   */
  private clearUpdateHook (instance: Component<unknown, unknown>): void {
    delete (instance as unknown as Record<symbol, unknown>)[SCHEDULE_UPDATE_HOOK];
  }

  /**
   * Adds a fiber to the dirty queue with ancestor deduplication and schedules a microtask flush.
   *
   * Deduplication:
   * - If an ancestor of the fiber is already queued → skip (ancestor covers the subtree).
   * - If descendants of the fiber are queued → remove them (fiber covers their subtrees).
   *
   * Skip scheduling when runtime is FAILED.
   *
   * @param {RuntimeFiber<unknown>} fiber - fiber whose subtree needs rebuild
   * @returns {void}
   */
  private scheduleUpdate (fiber: RuntimeFiber<unknown>): void {
    if (this.state === RUNTIME_STATE.FAILED || this.state === RUNTIME_STATE.UNMOUNTING || this.state === RUNTIME_STATE.UNMOUNTED) {
      return;
    }

    // If any ancestor is already queued — this fiber will be rebuilt as part of the ancestor
    let ancestor = fiber.parentFiber as RuntimeFiber<unknown> | null;
    while (ancestor !== null) {
      if (this.dirtyFibers.has(ancestor)) {
        return;
      }
      ancestor = ancestor.parentFiber as RuntimeFiber<unknown> | null;
    }

    // Remove descendants now covered by this fiber
    if (this.dirtyFibers.size > 0) {
      for (const existing of this.dirtyFibers) {
        let p = existing.parentFiber as RuntimeFiber<unknown> | null;
        while (p !== null) {
          if (p === fiber) {
            this.dirtyFibers.delete(existing);
            break;
          }
          p = p.parentFiber as RuntimeFiber<unknown> | null;
        }
      }
    }

    // Add fiber to the dirty queue
    this.dirtyFibers.add(fiber);

    // Schedule microtask dirty-flush
    this.scheduleDirtyFlushMicrotask();
  }

  /**
   * Enqueues an operation and starts the queue processor if idle.
   * Operations are executed sequentially; concurrent callers await the same in-flight operation.
   * Serialize all graph mutations.
   *
   * @param {() => Promise<void>} operation - operation to enqueue
   * @returns {Promise<void>}
   */
  private async enqueueOperation (operation: () => Promise<void>): Promise<void> {
    // True reentrancy: caller is on the async chain of the running queued operation
    // (e.g. onMount → await reconcile/unmount). Concurrent external callers have no
    // store and must enqueue. Reentrant awaits deadlock the single-threaded queue.
    // For unmount, {@link unmount} still schedules teardown via {@link enqueueOperationUnchecked}.
    if (this.operationAsyncContext.getStore() === true) {
      return Promise.reject(
        new Error(
          '[Effectable] GraphRuntime: reconcile/unmount cannot be awaited from inside an in-flight ' +
            'graph operation (e.g. onMount/onUpdate). That would deadlock the operation queue.',
        ),
      );
    }

    return this.enqueueOperationUnchecked(operation);
  }

  /**
   * Enqueues an operation without the reentrancy guard.
   * Used by {@link unmount} to schedule deferred teardown when called from inside a queued op.
   *
   * @param {() => Promise<void>} operation - operation to enqueue
   * @returns {Promise<void>}
   */
  private async enqueueOperationUnchecked (operation: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.operationQueue.push(async () => {
        try {
          await operation();
          resolve();
        } catch (error: unknown) {
          reject(error);
        }
      });

      if (!this.operationInProgress) {
        // Start processing without awaiting to allow concurrent enqueuing
        void this.processOperationQueue();
      }
    });
  }

  /**
   * Processes the operation queue: runs operations one at a time.
   * Single serialized owner of tree mutations.
   * Errors from individual operations are propagated to their callers but do not stop the queue.
   *
   * @returns {Promise<void>}
   */
  private async processOperationQueue (): Promise<void> {
    if (this.operationInProgress) {
      return;
    }

    this.operationInProgress = true;

    try {
      while (this.operationQueue.length > 0) {
        const operation = this.operationQueue.shift();
        if (operation === undefined) {
          break;
        }

        try {
          // Bind async context so lifecycle hooks (onMount/onUpdate) that call
          // reconcile/unmount are detected as reentrant; external concurrent
          // callers remain outside this store and only enqueue.
          await this.operationAsyncContext.run(true, operation);
        } catch {
          // Error is already propagated to the caller via the promise wrapper
          // Continue processing the queue (don't poison it forever)
        }
      }
    } finally {
      this.operationInProgress = false;
    }

    // setState during reconcile/unmount defers the microtask (operationInProgress).
    // Kick once the queue is idle so the flush cannot overlap in-flight graph mutations.
    if (this.dirtyFibers.size > 0 && this._state === RUNTIME_STATE.ACTIVE) {
      this.scheduleDirtyFlushMicrotask();
    }
  }

  /**
   * Queues one dirty-flush microtask and publishes {@link activeFlush} for await from `reconcile`.
   *
   * Skip scheduling when runtime is not ACTIVE (IDLE / FAILED / UNMOUNTING / UNMOUNTED),
   * a public graph operation is in flight, or an async flush is already running. Callers that
   * mutate `dirtyFibers` during those windows must kick this method again after the tree is
   * ACTIVE and idle ({@link GraphRuntime.mount} / {@link processOperationQueue}), or after the
   * outer flush finishes (end-of-pass kick).
   *
   * @returns {void}
   */
  private scheduleDirtyFlushMicrotask (): void {
    // Skip while an async flush is in flight: setState during PLACE/onMount only
    // enqueues dirtyFibers; the outer pass kicks the next microtask when it finishes.
    if (
      this.flushScheduled ||
      this.flushing ||
      this.operationInProgress ||
      this.state !== RUNTIME_STATE.ACTIVE
    ) {
      return;
    }

    this.flushScheduled = true;
    const flushWork = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        this.flushDirtyFibers()
          .catch(() => {
            // Error already handled in flushDirtyFibers (onAutoReconcileError + fail-stop)
          })
          .finally(() => {
            resolve();
          });
      });
    });

    const trackedFlush = flushWork.finally(() => {
      if (this.activeFlush === trackedFlush) {
        this.activeFlush = null;
      }
    });
    this.activeFlush = trackedFlush;
  }

  /**
   * Flushes accumulated dirty fibers.
   * Called from the microtask queued by {@link scheduleUpdate}.
   * Guarded by the `flushing` flag against re-entrancy.
   * The chain of repeat passes is capped by {@link GRAPH_RUNTIME_MAX_DIRTY_FLUSH_PASSES}.
   *
   * Respects state (UNMOUNTING/UNMOUNTED/FAILED) to cancel flush when unmount begins or failure occurs.
   * On unrecoverable error, invokes onAutoReconcileError then fail-stops.
   *
   * @returns {Promise<void>}
   */
  private async flushDirtyFibers (): Promise<void> {
    this.flushScheduled = false;

    if (this.state === RUNTIME_STATE.FAILED || this.state === RUNTIME_STATE.UNMOUNTING || this.state === RUNTIME_STATE.UNMOUNTED) {
      this.dirtyFibers.clear();
      return;
    }

    // Re-entrant call while an async flush awaits: keep dirtyFibers for the outer
    // pass's end-of-flush kick. Clearing here would silently drop setState updates.
    if (this.flushing) {
      return;
    }

    // Do not mutate the graph until mount has published currentRoot, and never
    // overlap a public reconcile/unmount (those leave dirtyFibers queued).
    if (this.state !== RUNTIME_STATE.ACTIVE || this.operationInProgress) {
      return;
    }

    this.dirtyFlushPassCount += 1;
    this.flushing = true;
    const snapshot = Array.from(this.dirtyFibers);
    this.dirtyFibers.clear();

    try {
      for (const fiber of snapshot) {
        if (this._state === RUNTIME_STATE.FAILED || this._state === RUNTIME_STATE.UNMOUNTING || this._state === RUNTIME_STATE.UNMOUNTED) {
          break;
        }
        const res = this.reconcileDirtyFiber(fiber);
        if (isThenable(res)) {
          await res;
        }
      }
    } catch (error: unknown) {
      this.flushing = false;

      // Notify error handler before fail-stop. The hook must not be allowed to
      // skip fail-stop: a throwing observer would leave the runtime ACTIVE with
      // fibers already run through runFiberFailedCleanup, and the microtask
      // `.catch(() => {})` would swallow the failure silently.
      if (this.onAutoReconcileError !== null) {
        try {
          this.onAutoReconcileError(error);
        } catch {
          // Observer/logging failures are non-fatal relative to fail-stop.
        }
      }

      // Fail-stop on unrecoverable dirty-flush error
      const failError = error instanceof Error ? error : new Error(String(error));
      const failRes = this.failStop(failError);
      if (isThenable(failRes)) {
        await failRes;
      }

      throw failError;
    } finally {
      this.flushing = false;
    }

    // If new dirty fibers appeared during flush — schedule the next pass
    if (this.dirtyFibers.size > 0 && this.state === RUNTIME_STATE.ACTIVE) {
      if (this.dirtyFlushPassCount >= GRAPH_RUNTIME_MAX_DIRTY_FLUSH_PASSES) {
        this.dirtyFibers.clear();
        this.dirtyFlushPassCount = 0;
        const loopError = new Error(
          `GraphRuntime: dirty flush exceeded ${String(GRAPH_RUNTIME_MAX_DIRTY_FLUSH_PASSES)} passes (anti-loop)`
        );

        // Same contract as the catch path: observer throw must not skip fail-stop.
        if (this.onAutoReconcileError !== null) {
          try {
            this.onAutoReconcileError(loopError);
          } catch {
            // Observer/logging failures are non-fatal relative to fail-stop.
          }
        }

        // Fail-stop on loop limit
        const failRes = this.failStop(loopError);
        if (isThenable(failRes)) {
          await failRes;
        }

        throw loopError;
      }
      this.scheduleDirtyFlushMicrotask();
    } else {
      this.dirtyFlushPassCount = 0;
    }
  }

  /**
   * Rebuilds the `compose()` subtree of one dirty fiber without updating its props.
   *
   * Used for automatic reconcile after `setState()`: the instance already updated `state`,
   * we only need to call `compose()` again and diff children.
   *
   * @param {RuntimeFiber<unknown>} fiber - fiber whose subtree needs rebuild
   * @returns {void | Promise<void>}
   */

  /**
   * Assigns `fiber.children` and keeps {@link FiberConstructionJournal.mountedChildren}
   * in sync when a journal exists.
   *
   * Mount aliases `fiber.children` to `journal.mountedChildren`. Later UPDATE / dirty
   * reconcile reassigns `fiber.children` to a fresh array without updating the journal,
   * so destroyed sibling fibers stayed reachable until the parent unmounted (leak under
   * keyed list churn).
   *
   * @param {RuntimeFiber<unknown>} fiber - fiber whose children are being replaced
   * @param {Fiber[]} children - next child fibers
   * @returns {void}
   */
  private setFiberChildren (fiber: RuntimeFiber<unknown>, children: Fiber[]): void {
    fiber.children = children;
    const journal = fiber.constructionJournal;
    if (journal !== undefined) {
      journal.mountedChildren = children as RuntimeFiber<unknown>[];
    }
  }

  private reconcileDirtyFiber (fiber: RuntimeFiber<unknown>): void | Promise<void> {
    if (this.state === RUNTIME_STATE.UNMOUNTING || this.state === RUNTIME_STATE.UNMOUNTED) {
      return;
    }

    const instance = fiber.instance;
    if (instance === null) {
      return;
    }

    try {
      const childScope = this.buildChildScope(instance, fiber.scope);
      const nextChildVnodes = this.getChildVnodes(instance, fiber.vnode.children);

      const childrenRes = this.reconcileChildren(
        fiber.children as RuntimeFiber<unknown>[],
        nextChildVnodes,
        fiber,
        childScope,
      );

      if (isThenable(childrenRes)) {
        return childrenRes.then(
          (nextChildren) => {
            this.setFiberChildren(fiber, nextChildren as Fiber[]);
          },
          (error: unknown) => {
            const cleanupResult = this.runFiberFailedCleanup(fiber, error);
            if (isThenable(cleanupResult)) {
              return cleanupResult.then(() => {
                throw error;
              });
            }
            throw error;
          },
        );
      }

      this.setFiberChildren(fiber, childrenRes as Fiber[]);
    } catch (error: unknown) {
      const cleanupResult = this.runFiberFailedCleanup(fiber, error);
      if (isThenable(cleanupResult)) {
        return cleanupResult.then(() => {
          throw error;
        });
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Mounts a component tree and returns a running GraphRuntime.
   * Builds the fiber tree, injects contexts, runs lifecycle in order:
   * child nodes first, then the parent.
   *
   * @param {VirtualServiceNode<P>} root - root virtual node
   * @param {ContextScope} initialScope - initial context scope (empty by default)
   * @returns {Promise<GraphRuntime>} running runtime
   * @throws {Error} if any node's startup failed
   */
  public static async mount<P = unknown>(
    root: VirtualServiceNode<P>,
    initialScope: ContextScope = EMPTY_CONTEXT_SCOPE,
    runtimeBuses?: RuntimeBusesBundle<RuntimeCommand, RuntimeQuery, RuntimeEvent>,
    onAutoReconcileError?: (err: unknown) => void,
  ): Promise<GraphRuntime> {
    const rt = new GraphRuntime();
    rt.effectableRuntimeBuses = typeof runtimeBuses === 'undefined' ? null : runtimeBuses;
    rt.onAutoReconcileError = typeof onAutoReconcileError === 'function' ? onAutoReconcileError : null;
    
    try {
      const res = rt.materialize(
        root as VirtualServiceNode<unknown>,
        null,
        initialScope,
      );
      rt.currentRoot = isThenable(res) ? await res : res;
      if (rt._state === RUNTIME_STATE.FAILED) {
        throw rt.terminalError ?? new Error(
          '[Effectable] GraphRuntime: terminal failure during mount.'
        );
      }
      rt.state = RUNTIME_STATE.ACTIVE;
      if (rt.dirtyFibers.size > 0) {
        rt.scheduleDirtyFlushMicrotask();
      }
      return rt;
    } catch (error: unknown) {
      // Fail-stop on unrecoverable mount error
      const failError = error instanceof Error ? error : new Error(String(error));
      const failRes = rt.failStop(failError);
      if (isThenable(failRes)) {
        await failRes;
      }
      throw failError;
    }
  }

  /**
   * Reconciles against a new tree.
   * Diffs the current tree against the new one, computes effectTags, applies changes:
   * - PLACE: create and mount a new node
   * - UPDATE: update props on an existing instance, call onUpdate
   * - DELETE: unmount and destroy a node
   *
   * All reconcile calls are serialized through the operation queue.
   * Rejects with terminal error when runtime is FAILED.
   *
   * @param {VirtualServiceNode<P>} nextTree - new virtual tree
   * @returns {Promise<void>}
   * @throws {Error} if the runtime state is UNMOUNTING, UNMOUNTED, or FAILED
   */
  public async reconcile<P = unknown>(nextTree: VirtualServiceNode<P>): Promise<void> {
    // Reject immediately if unmount has started or completed
    if (this.state === RUNTIME_STATE.UNMOUNTING || this.state === RUNTIME_STATE.UNMOUNTED) {
      throw new Error('[Effectable] GraphRuntime: reconcile attempted after unmount started.');
    }

    // Reject immediately if runtime is in failed state
    if (this.state === RUNTIME_STATE.FAILED) {
      throw this.terminalError || new Error('[Effectable] GraphRuntime: reconcile attempted after terminal failure.');
    }

    // Serialize via operation queue
    await this.enqueueOperation(async () => {
      // Double-check after queue wait
      if (this.state === RUNTIME_STATE.UNMOUNTING || this.state === RUNTIME_STATE.UNMOUNTED) {
        throw new Error('[Effectable] GraphRuntime: reconcile attempted after unmount started.');
      }

      if (this.state === RUNTIME_STATE.FAILED) {
        throw this.terminalError || new Error('[Effectable] GraphRuntime: reconcile attempted after terminal failure.');
      }

      if (this.currentRoot === null) {
        throw new Error('[Effectable] GraphRuntime: currentRoot is not initialized.');
      }

      // Await the full dirty-flush chain (including re-schedule) — otherwise manual
      // reconcile overlaps the snapshot auto-flush.
      while (this.activeFlush !== null) {
        await this.activeFlush;
      }

      if (this._state === RUNTIME_STATE.UNMOUNTING || this._state === RUNTIME_STATE.UNMOUNTED) {
        throw new Error('[Effectable] GraphRuntime: reconcile attempted after unmount started.');
      }

      if (this._state === RUNTIME_STATE.FAILED) {
        throw this.terminalError || new Error('[Effectable] GraphRuntime: reconcile attempted after terminal failure.');
      }

      // Manual reconcile covers the whole tree from the root: cancel pending auto-flush
      // to avoid double-mounting components from concurrent reconcile paths.
      this.dirtyFibers.clear();
      this.flushScheduled = false;
      this.dirtyFlushPassCount = 0;

      try {
        const res = this.reconcileFiber(
          this.currentRoot,
          nextTree as VirtualServiceNode<unknown>,
          null,
          this.currentRoot.scope,
        );

        this.currentRoot = isThenable(res) ? await res : res;
      } catch (error: unknown) {
        // Fail-stop on unrecoverable reconcile error
        // Let failStop destroy current tree and null currentRoot (single owner)
        const failError = error instanceof Error ? error : new Error(String(error));
        const failRes = this.failStop(failError);
        if (isThenable(failRes)) {
          await failRes;
        }
        throw failError;
      }
    });
  }

  /**
   * Fully unmounts the component tree.
   * Calls onUnmount for each node (children before parent) and
   * moves stages to destroyed via LifecycleEngine.
   *
   * Unmount is serialized, cached promise returned for concurrent callers.
   * Safe and joinable even when runtime is FAILED.
   * Collects cleanup errors when `rejectOnCleanupError: true` is passed.
   *
   * @param {object} [options] - unmount options
   * @param {boolean} [options.rejectOnCleanupError=false] - reject on cleanup errors
   * @returns {Promise<void>}
   */
  public async unmount (options?: { rejectOnCleanupError?: boolean }): Promise<void> {
    const rejectOnCleanupError = options?.rejectOnCleanupError === true;

    // If unmount is in progress, return the cached promise (HOLE 1)
    // Must check BEFORE the UNMOUNTED early-return so concurrent callers join the in-flight unmount
    if (this.cachedUnmountPromise !== null) {
      return this.cachedUnmountPromise;
    }

    // If unmount already completed, return immediately
    if (this.state === RUNTIME_STATE.UNMOUNTED) {
      return;
    }

    // Transition to UNMOUNTING state (reject new reconcile calls)
    // If already FAILED, stay FAILED until unmount completes
    if (this.state !== RUNTIME_STATE.FAILED) {
      this.state = RUNTIME_STATE.UNMOUNTING;
    }

    // Reentrant unmount from onMount/onUpdate: schedule teardown on the queue (so the
    // current op's while-loop runs it next) but reject the awaiter — awaiting the cached
    // promise here would deadlock. External callers still join via cachedUnmountPromise.
    if (this.operationAsyncContext.getStore() === true) {
      this.cachedUnmountPromise = this.enqueueOperationUnchecked(async () => {
        await this.runUnmountOperation(rejectOnCleanupError);
      });
      throw new Error(
        '[Effectable] GraphRuntime: unmount cannot be awaited from inside an in-flight ' +
          'graph operation (e.g. onMount/onUpdate); teardown was scheduled on the operation queue.',
      );
    }

    // Create and cache the unmount promise
    this.cachedUnmountPromise = this.enqueueOperation(async () => {
      await this.runUnmountOperation(rejectOnCleanupError);
    });

    return this.cachedUnmountPromise;
  }

  /**
   * Body of a queued unmount operation (shared by normal and deferred reentrant paths).
   *
   * @param {boolean} rejectOnCleanupError - whether cleanup errors should reject
   * @returns {Promise<void>}
   */
  private async runUnmountOperation (rejectOnCleanupError: boolean): Promise<void> {
    // Double-check unmounted state
    if (this.state === RUNTIME_STATE.UNMOUNTED) {
      return;
    }

    // Cancel any pending dirty flush
    this.dirtyFibers.clear();
    this.flushScheduled = false;

    // Wait for in-flight dirty flush to complete
    if (this.activeFlush !== null) {
      try {
        await this.activeFlush;
      } catch {
        // Ignore flush errors during unmount
      }
    }

    // HOLE 1: stay UNMOUNTING during destroy (not UNMOUNTED)
    // If already FAILED, keep FAILED state through destroy
    // State transition to UNMOUNTED happens AFTER destroy completes

    // If pendingTeardown is active (fail-stop in progress), await it first
    if (this.pendingTeardown !== null) {
      try {
        await this.pendingTeardown;
      } catch {
        // Ignore errors — they are already attached to the fail-stop primary error
      }
    }

    if (this.currentRoot !== null) {
      // Collect cleanup errors during unmount
      const cleanupErrors: Error[] = [];
      const d = this.destroyFiber(this.currentRoot, cleanupErrors);
      if (isThenable(d)) {
        await d;
      }
      this.currentRoot = null;

      // HOLE 1: set UNMOUNTED only after destroy finishes
      // Transition even if FAILED — unmount is the terminal operation
      this.state = RUNTIME_STATE.UNMOUNTED;

      // Reject with cleanup errors when requested
      if (rejectOnCleanupError && cleanupErrors.length > 0) {
        if (cleanupErrors.length === 1) {
          throw cleanupErrors[0];
        }
        throw new AggregateError(cleanupErrors, 'Cleanup errors during unmount');
      }
    } else {
      // No root to destroy — transition to UNMOUNTED
      this.state = RUNTIME_STATE.UNMOUNTED;
    }
  }

  /**
   * Returns the root component instance (for testing and introspection).
   *
   * @returns {Component<unknown, unknown> | null}
   */
  public getRootInstance (): Component<unknown, unknown> | null {
    if (this.currentRoot === null) {
      return null;
    }

    return this.currentRoot.instance;
  }

  /**
   * Whether the runtime is active (not failed and unmount has not been called).
   * Returns false when state is FAILED.
   *
   * @returns {boolean}
   */
  public isActive (): boolean {
    return this.state === RUNTIME_STATE.ACTIVE;
  }

  /**
   * Readonly snapshot of the root fiber tree for test/debug introspection.
   * Does not export mutable RuntimeFiber; returns null after unmount.
   *
   * @returns {FiberInspectNode | null} root snapshot or null
   */
  public inspectRootFiber (): FiberInspectNode | null {
    if (this.currentRoot === null) {
      return null;
    }

    return this.toFiberInspectNode(this.currentRoot);
  }

  /**
   * Entity tests only: nulls the root fiber `instance`
   * to exercise the UPDATE guard when `fiber.instance === null`.
   * Do not use in the production control plane.
   *
   * @returns {void}
   */
  public nullRootInstanceForTests (): void {
    if (this.currentRoot === null) {
      return;
    }

    this.currentRoot.instance = null;
  }

  /**
   * Number of {@link continueStableReconcileAsync} calls since runtime creation.
   * Test/debug probe; not a production API.
   *
   * @returns {number} accumulated counter
   */
  public getStableAsyncContinueCount (): number {
    return this.stableAsyncContinueCount;
  }

  /**
   * Current runtime state.
   * Test/debug probe; not a production API.
   *
   * @returns {RuntimeState} current state
   */
  public getState (): RuntimeState {
    return this.state;
  }

  /**
   * Builds a deep readonly {@link FiberInspectNode} from a RuntimeFiber.
   *
   * @param {RuntimeFiber} fiber - source fiber
   * @returns {FiberInspectNode} node snapshot
   */
  private toFiberInspectNode (fiber: RuntimeFiber): FiberInspectNode {
    const children: FiberInspectNode[] = [];

    for (let i = 0; i < fiber.children.length; i++) {
      children.push(this.toFiberInspectNode(fiber.children[i] as RuntimeFiber));
    }

    const keyRaw = fiber.vnode.key;
    const key = keyRaw === undefined ? null : keyRaw;

    return {
      effectTag: fiber.effectTag,
      hasInstance: fiber.instance !== null,
      key,
      childCount: fiber.children.length,
      children,
    };
  }

  // ---------------------------------------------------------------------------
  // Materialize
  // ---------------------------------------------------------------------------

  /**
   * Runs deferred `onUpdate` for a fiber subtree in children→parent order
   * (siblings in compose order). Call after sibling PLACE/REPLACE peers have
   * finished `@On*` bus wiring and before {@link flushDeferredLifecycleTree}.
   *
   * @param {RuntimeFiber<unknown>} fiber - subtree root
   * @returns {void | Promise<void>}
   */
  private flushPendingOnUpdateTree (
    fiber: RuntimeFiber<unknown>,
  ): void | Promise<void> {
    const children = fiber.children as RuntimeFiber<unknown>[];
    for (let i = 0; i < children.length; i++) {
      const childFlush = this.flushPendingOnUpdateTree(children[i] as RuntimeFiber<unknown>);
      if (isThenable(childFlush)) {
        return this.continueFlushPendingOnUpdateAsync(fiber, children, i, childFlush);
      }
    }

    return this.runPendingOnUpdateIfNeeded(fiber);
  }

  /**
   * Async continuation of {@link flushPendingOnUpdateTree}.
   *
   * @param {RuntimeFiber<unknown>} fiber - subtree root
   * @param {RuntimeFiber<unknown>[]} children - child fibers
   * @param {number} pendingIdx - index of the pending child
   * @param {PromiseLike<void>} pending - pending child flush
   * @returns {Promise<void>}
   */
  private async continueFlushPendingOnUpdateAsync (
    fiber: RuntimeFiber<unknown>,
    children: RuntimeFiber<unknown>[],
    pendingIdx: number,
    pending: PromiseLike<void>,
  ): Promise<void> {
    await pending;
    for (let i = pendingIdx + 1; i < children.length; i++) {
      const childFlush = this.flushPendingOnUpdateTree(children[i] as RuntimeFiber<unknown>);
      if (isThenable(childFlush)) {
        await childFlush;
      }
    }
    const selfRes = this.runPendingOnUpdateIfNeeded(fiber);
    if (isThenable(selfRes)) {
      await selfRes;
    }
  }

  /**
   * Invokes a stashed `onUpdate` when {@link RuntimeFiber.hasPendingOnUpdate} is set.
   *
   * @param {RuntimeFiber<unknown>} fiber - fiber with optional pending onUpdate
   * @returns {void | Promise<void>}
   */
  private runPendingOnUpdateIfNeeded (
    fiber: RuntimeFiber<unknown>,
  ): void | Promise<void> {
    if (fiber.hasPendingOnUpdate !== true) {
      return;
    }

    const instance = fiber.instance;
    const prevProps = fiber.pendingOnUpdatePrevProps;
    fiber.hasPendingOnUpdate = false;
    fiber.pendingOnUpdatePrevProps = undefined;

    if (instance === null || !fiber.engine.canUpdate()) {
      return;
    }

    try {
      instance.onUpdate(prevProps, instance.props);
    } catch (error: unknown) {
      const cleanupResult = this.runFiberFailedCleanup(fiber, error);
      if (isThenable(cleanupResult)) {
        return cleanupResult.then(() => {
          throw error;
        });
      }
      throw error;
    }
  }

  /**
   * Flushes pending onUpdates then deferred startups for a sibling batch.
   *
   * @param {RuntimeFiber<unknown>[]} nextChildren - reconciled sibling fibers
   * @returns {void | Promise<void>}
   */
  private flushSiblingBatchHooks (
    nextChildren: RuntimeFiber<unknown>[],
  ): void | Promise<void> {
    for (let i = 0; i < nextChildren.length; i++) {
      const onUpdateFlush = this.flushPendingOnUpdateTree(nextChildren[i] as RuntimeFiber<unknown>);
      if (isThenable(onUpdateFlush)) {
        return this.continueFlushSiblingBatchHooksAsync(nextChildren, i, onUpdateFlush, 'onUpdate');
      }
    }

    for (let i = 0; i < nextChildren.length; i++) {
      const child = nextChildren[i] as RuntimeFiber<unknown>;
      if (child.constructionJournal?.lifecycleDeferred === true) {
        const lifecycleFlush = this.flushDeferredLifecycleTree(child);
        if (isThenable(lifecycleFlush)) {
          return this.continueFlushSiblingBatchHooksAsync(nextChildren, i, lifecycleFlush, 'lifecycle');
        }
      }
    }
  }

  /**
   * Async continuation of {@link flushSiblingBatchHooks}.
   *
   * @param {RuntimeFiber<unknown>[]} nextChildren - sibling fibers
   * @param {number} pendingIdx - index being awaited
   * @param {PromiseLike<void>} pending - pending flush
   * @param {'onUpdate' | 'lifecycle'} phase - which loop to resume
   * @returns {Promise<void>}
   */
  private async continueFlushSiblingBatchHooksAsync (
    nextChildren: RuntimeFiber<unknown>[],
    pendingIdx: number,
    pending: PromiseLike<void>,
    phase: 'onUpdate' | 'lifecycle',
  ): Promise<void> {
    await pending;

    if (phase === 'onUpdate') {
      for (let i = pendingIdx + 1; i < nextChildren.length; i++) {
        const onUpdateFlush = this.flushPendingOnUpdateTree(nextChildren[i] as RuntimeFiber<unknown>);
        if (isThenable(onUpdateFlush)) {
          await onUpdateFlush;
        }
      }
      pendingIdx = -1;
    }

    const lifecycleStart = phase === 'lifecycle' ? pendingIdx + 1 : 0;
    for (let i = lifecycleStart; i < nextChildren.length; i++) {
      const child = nextChildren[i] as RuntimeFiber<unknown>;
      if (child.constructionJournal?.lifecycleDeferred === true) {
        const lifecycleFlush = this.flushDeferredLifecycleTree(child);
        if (isThenable(lifecycleFlush)) {
          await lifecycleFlush;
        }
      }
    }
  }

  /**
   * Runs deferred {@link LifecycleEngine.runStartup} for a fiber subtree in
   * children→parent order (siblings in compose order).
   *
   * Call only after the subtree (and any later siblings that must observe
   * publishes) have completed bus wiring. Idempotent for fibers that already
   * started.
   *
   * @param {RuntimeFiber<unknown>} fiber - subtree root
   * @returns {void | Promise<void>}
   */
  private flushDeferredLifecycleTree (
    fiber: RuntimeFiber<unknown>,
  ): void | Promise<void> {
    const children = fiber.children as RuntimeFiber<unknown>[];
    for (let i = 0; i < children.length; i++) {
      const child = children[i] as RuntimeFiber<unknown>;
      const childFlush = this.flushDeferredLifecycleTree(child);
      if (isThenable(childFlush)) {
        return this.continueFlushDeferredLifecycleAsync(fiber, children, i, childFlush);
      }
    }

    return this.runDeferredLifecycleIfNeeded(fiber);
  }

  /**
   * Async continuation of {@link flushDeferredLifecycleTree} after a child flush returns a Promise.
   *
   * @param {RuntimeFiber<unknown>} fiber - subtree root
   * @param {RuntimeFiber<unknown>[]} children - child fibers
   * @param {number} pendingIdx - index of the pending child
   * @param {PromiseLike<void>} pending - pending child flush
   * @returns {Promise<void>}
   */
  private async continueFlushDeferredLifecycleAsync (
    fiber: RuntimeFiber<unknown>,
    children: RuntimeFiber<unknown>[],
    pendingIdx: number,
    pending: PromiseLike<void>,
  ): Promise<void> {
    await pending;
    for (let i = pendingIdx + 1; i < children.length; i++) {
      const childFlush = this.flushDeferredLifecycleTree(children[i] as RuntimeFiber<unknown>);
      if (isThenable(childFlush)) {
        await childFlush;
      }
    }
    const selfRes = this.runDeferredLifecycleIfNeeded(fiber);
    if (isThenable(selfRes)) {
      await selfRes;
    }
  }

  /**
   * Runs startup + update-hook injection when {@link FiberConstructionJournal.lifecycleDeferred}
   * is set; no-op otherwise.
   *
   * @param {RuntimeFiber<unknown>} fiber - fiber to start
   * @returns {void | Promise<void>}
   */
  private runDeferredLifecycleIfNeeded (
    fiber: RuntimeFiber<unknown>,
  ): void | Promise<void> {
    const journal = fiber.constructionJournal;
    if (journal === undefined || journal.lifecycleDeferred !== true) {
      return;
    }

    const instance = fiber.instance;
    if (instance === null) {
      journal.lifecycleDeferred = false;
      return;
    }

    const startupRes = fiber.engine.runStartup(instance, { deferFailedCleanup: true });
    if (isThenable(startupRes)) {
      return this.finalizeDeferredLifecycleAsync(fiber, startupRes);
    }

    if (!startupRes.ok) {
      const error = startupRes.error instanceof Error
        ? startupRes.error
        : new Error(String(startupRes.error));
      const rollbackRes = this.rollbackFailedMaterialization(fiber, error);
      if (isThenable(rollbackRes)) {
        return rollbackRes.then(() => {
          throw error;
        });
      }
      throw error;
    }

    journal.lifecycleDeferred = false;
    fiber.lifecycleStatus = fiber.engine.getStatus();
    fiber.effectTag = null;
    journal.schedulerHookAttached = true;
    this.injectUpdateHook(instance, fiber);
  }

  /**
   * Async path for {@link runDeferredLifecycleIfNeeded} when startup returns a Promise.
   *
   * @param {RuntimeFiber<unknown>} fiber - fiber being started
   * @param {PromiseLike<import('./lifecycle').LifecycleTransitionResult>} pendingStartup - pending startup
   * @returns {Promise<void>}
   */
  private async finalizeDeferredLifecycleAsync (
    fiber: RuntimeFiber<unknown>,
    pendingStartup: PromiseLike<import('./lifecycle').LifecycleTransitionResult>,
  ): Promise<void> {
    const result = await pendingStartup;
    const journal = fiber.constructionJournal!;
    const instance = fiber.instance;

    if (!result.ok) {
      const error = result.error instanceof Error ? result.error : new Error(String(result.error));
      const rollbackRes = this.rollbackFailedMaterialization(fiber, error);
      if (isThenable(rollbackRes)) {
        await rollbackRes;
      }
      throw error;
    }

    journal.lifecycleDeferred = false;
    fiber.lifecycleStatus = fiber.engine.getStatus();
    fiber.effectTag = null;
    if (instance !== null) {
      journal.schedulerHookAttached = true;
      this.injectUpdateHook(instance, fiber);
    }
  }

  /**
   * After bus wiring: either defer lifecycle (sibling/parent batching) or flush
   * deferred children and run this fiber's startup.
   *
   * @template P node props type
   * @param {RuntimeFiber<P>} fiber - fiber that just finished wiring
   * @param {Component<unknown, P>} instance - component instance
   * @param {LifecycleEngine} engine - lifecycle engine
   * @param {boolean} deferLifecycle - when true, skip startup until a parent flush
   * @returns {RuntimeFiber<P> | Promise<RuntimeFiber<P>>}
   */
  private completeMaterializeAfterWiring<P> (
    fiber: RuntimeFiber<P>,
    instance: Component<unknown, P>,
    engine: LifecycleEngine,
    deferLifecycle: boolean,
  ): RuntimeFiber<P> | Promise<RuntimeFiber<P>> {
    const journal = fiber.constructionJournal!;

    if (deferLifecycle) {
      journal.lifecycleDeferred = true;
      return fiber;
    }

    // Children were materialized with deferLifecycle=true — start them (and their
    // subtrees) before this node's onMount so sibling/parent @On* handlers exist.
    // If a deferred sibling fails during flush after an earlier sibling started,
    // roll back this parent (destroys all mounted children) — same contract as
    // the pre-defer depth-first materialize catch around each child.
    try {
      const children = fiber.children as RuntimeFiber<unknown>[];
      for (let i = 0; i < children.length; i++) {
        const childFlush = this.flushDeferredLifecycleTree(children[i] as RuntimeFiber<unknown>);
        if (isThenable(childFlush)) {
          return this.continueCompleteMaterializeAfterWiringAsync(
            fiber,
            instance,
            engine,
            children,
            i,
            childFlush,
          );
        }
      }

      return this.runMaterializeStartup(fiber, instance, engine);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const rollbackRes = this.rollbackFailedMaterialization(fiber as RuntimeFiber<unknown>, error);
      if (isThenable(rollbackRes)) {
        return rollbackRes.then(() => {
          throw error;
        }) as Promise<RuntimeFiber<P>>;
      }
      throw error;
    }
  }

  /**
   * Async continuation after a deferred child flush during materialize completion.
   *
   * @template P node props type
   * @param {RuntimeFiber<P>} fiber - parent fiber
   * @param {Component<unknown, P>} instance - parent instance
   * @param {LifecycleEngine} engine - parent engine
   * @param {RuntimeFiber<unknown>[]} children - child fibers
   * @param {number} pendingIdx - pending child index
   * @param {PromiseLike<void>} pending - pending flush
   * @returns {Promise<RuntimeFiber<P>>}
   */
  private async continueCompleteMaterializeAfterWiringAsync<P> (
    fiber: RuntimeFiber<P>,
    instance: Component<unknown, P>,
    engine: LifecycleEngine,
    children: RuntimeFiber<unknown>[],
    pendingIdx: number,
    pending: PromiseLike<void>,
  ): Promise<RuntimeFiber<P>> {
    try {
      await pending;
      for (let i = pendingIdx + 1; i < children.length; i++) {
        const childFlush = this.flushDeferredLifecycleTree(children[i] as RuntimeFiber<unknown>);
        if (isThenable(childFlush)) {
          await childFlush;
        }
      }
      return this.runMaterializeStartup(fiber, instance, engine);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const rollbackRes = this.rollbackFailedMaterialization(fiber as RuntimeFiber<unknown>, error);
      if (isThenable(rollbackRes)) {
        await rollbackRes;
      }
      throw error;
    }
  }

  /**
   * Runs startup for a fiber that is completing materialize (not deferred).
   *
   * @template P node props type
   * @param {RuntimeFiber<P>} fiber - fiber
   * @param {Component<unknown, P>} instance - instance
   * @param {LifecycleEngine} engine - engine
   * @returns {RuntimeFiber<P> | Promise<RuntimeFiber<P>>}
   */
  private runMaterializeStartup<P> (
    fiber: RuntimeFiber<P>,
    instance: Component<unknown, P>,
    engine: LifecycleEngine,
  ): RuntimeFiber<P> | Promise<RuntimeFiber<P>> {
    const startupRes = engine.runStartup(instance, { deferFailedCleanup: true });

    if (isThenable(startupRes)) {
      return this.finalizeMaterializeAsync(fiber, engine, startupRes);
    }

    if (!startupRes.ok) {
      const error = startupRes.error instanceof Error ? startupRes.error : new Error(String(startupRes.error));
      const rollbackRes = this.rollbackFailedMaterialization(fiber, error);
      if (isThenable(rollbackRes)) {
        return rollbackRes.then(() => {
          throw error;
        }) as Promise<RuntimeFiber<P>>;
      }
      throw error;
    }

    fiber.lifecycleStatus = engine.getStatus();
    fiber.effectTag = null;
    fiber.constructionJournal!.schedulerHookAttached = true;
    this.injectUpdateHook(instance, fiber);
    return fiber;
  }

  /**
   * Creates a RuntimeFiber for a virtual node: instantiates the component,
   * injects contexts, builds the child scope (for ContextProvider),
   * recursively materializes children, binds ref, runs lifecycle.
   *
   * Returns {@link RuntimeFiber} synchronously if the whole subtree is sync
   * (up to 116x speedup for a tree of 16 sync children); otherwise a Promise.
   * `await` works correctly with either union branch.
   *
   * @param {VirtualServiceNode<P>} vnode - virtual node
   * @param {RuntimeFiber | null} parentFiber - parent fiber
   * @param {ContextScope} parentScope - parent scope
   * @param {boolean} [deferLifecycle=false] - when true, wire buses but defer onMount
   *   until {@link flushDeferredLifecycleTree} (used for sibling batching)
   * @returns {RuntimeFiber<P> | Promise<RuntimeFiber<P>>}
   */
  private materialize<P>(
    vnode: VirtualServiceNode<P>,
    parentFiber: RuntimeFiber<unknown> | null,
    parentScope: ContextScope,
    deferLifecycle: boolean = false,
  ): RuntimeFiber<P> | Promise<RuntimeFiber<P>> {
    const engine = new LifecycleEngine();
    // Constructor is stored as ComponentConstructor<unknown> for covariance,
    // but invoked with concrete props P. The cast is safe: P extends unknown.
    const instance = new vnode.type(vnode.props) as Component<unknown, P>;

    // connect installs CONNECT_REBIND_LIFECYCLE so subclass-of-Connected class fields
    // that overwrite own onMount/onUnmount after Connected's constructor can be
    // re-captured before hookFlags / startup see the shadowed hooks.
    const rebindConnectLifecycle = (instance as unknown as Record<symbol, unknown>)[CONNECT_REBIND_LIFECYCLE];
    if (typeof rebindConnectLifecycle === 'function') {
      (rebindConnectLifecycle as () => void).call(instance);
    }

    // Cache hookFlags once for fast-exit in runStartup/runShutdown (1.15x)
    engine.initHookFlags(instance);

    // Inject @UseContext fields before startup
    injectContextFields(instance, parentScope);

    // Build scope for child nodes: ContextProvider extends the scope
    const childScope = this.buildChildScope(instance, parentScope);

    const fiber: RuntimeFiber<P> = {
      vnode,
      instance,
      lifecycleStatus: 'registered',
      children: [],
      parentFiber: parentFiber as RuntimeFiber<unknown> | null,
      alternate: null,
      pendingProps: null,
      effectTag: FIBER_EFFECT_TAG.PLACE,
      engine,
      scope: parentScope,
      constructionJournal: {
        mountedChildren: [],
      },
    };

    // Buffer setState before children mount: a descendant onMount may call
    // ancestor setState (via props callback). Without this hook, that update
    // mutates state but never schedules reconcile.
    this.injectPreMountUpdateHook(instance, fiber);

    // compose() / duplicate-key validation can throw after the pre-mount hook is
    // attached. Roll back so the hook is cleared (otherwise the failed fiber is
    // abandoned with a live SCHEDULE_UPDATE_HOOK and no teardown).
    let childVnodes: VirtualServiceNode[];
    try {
      childVnodes = this.getChildVnodes(instance, vnode.children);

      // Validate unique keys BEFORE materialization (Option A: React v16.5 contract)
      // Prevent partial tree construction when duplicate keys are present
      this.validateUniqueKeys(
        childVnodes.map(vnode => ({ vnode, instance: null })),
        fiber as RuntimeFiber<unknown>,
        'current'
      );
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const rollbackRes = this.rollbackFailedMaterialization(fiber, error);
      if (isThenable(rollbackRes)) {
        return rollbackRes.then(() => {
          throw error;
        }) as Promise<RuntimeFiber<P>>;
      }
      throw error;
    }

    // Wire parent buses BEFORE children materialize/onMount. Children run onMount while
    // descending; if the parent is not subscribed yet, child publishes to @OnEvent /
    // @OnCommand on the parent are silently dropped (mirror of #80 teardown order).
    try {
      this.attachEffectableRuntimeBusWiring(instance, fiber);
      if (fiber.effectableRuntimeBusDisposer !== undefined) {
        fiber.constructionJournal!.busWiringAttached = true;
      }
    } catch (err) {
      const rollbackRes = this.rollbackFailedMaterialization(
        fiber,
        err instanceof Error ? err : new Error(String(err)),
      );
      if (isThenable(rollbackRes)) {
        return rollbackRes.then(() => {
          throw err;
        }) as Promise<RuntimeFiber<P>>;
      }
      throw err;
    }

    for (let i = 0; i < childVnodes.length; i++) {
      const childVnode = childVnodes[i] as VirtualServiceNode;
      let childRes: RuntimeFiber<unknown> | Promise<RuntimeFiber<unknown>>;

      try {
        // Defer child lifecycle so all siblings (and this parent) finish bus wiring
        // before any onMount runs — otherwise earlier-sibling publishes miss later
        // siblings' @On* handlers (and parent handlers miss child onMount publishes).
        childRes = this.materialize(
          childVnode,
          fiber as RuntimeFiber<unknown>,
          childScope,
          true,
        );
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        const rollbackRes = this.rollbackFailedMaterialization(fiber, error);
        if (isThenable(rollbackRes)) {
          return rollbackRes.then(() => {
            throw error;
          }) as Promise<RuntimeFiber<P>>;
        }
        throw error;
      }

      if (isThenable(childRes)) {
        // Hit an async child — continue the materialization tail in the async continuation.
        return this.continueMaterializeAsync(
          fiber,
          instance,
          engine,
          vnode,
          childVnodes,
          childScope,
          childRes,
          i,
          deferLifecycle,
        );
      }

      fiber.constructionJournal!.mountedChildren.push(childRes as RuntimeFiber<unknown>);
    }

    fiber.children = fiber.constructionJournal!.mountedChildren as Fiber[];

    // Bind ref to the instance (centralized via commitRef).
    // Mark refBound/refOwner BEFORE commitRef: a setter may assign `current`
    // then throw. If the flags were set only after a successful return,
    // rollback would skip the identity-safe clear and leave a zombie ref
    // (root was never published, so failStop cannot reclaim it).
    if (vnode.ref !== undefined) {
      try {
        fiber.constructionJournal!.refBound = true;
        fiber.constructionJournal!.refOwner = instance;
        this.commitRef(undefined, null, vnode.ref, instance);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        const rollbackRes = this.rollbackFailedMaterialization(fiber, error);
        if (isThenable(rollbackRes)) {
          return rollbackRes.then(() => {
            throw error;
          }) as Promise<RuntimeFiber<P>>;
        }
        throw error;
      }
    }

    // Parent buses already wired before children (see above). Do not wire again here.

    return this.completeMaterializeAfterWiring(fiber, instance, engine, deferLifecycle);
  }

  /**
   * Async continuation of {@link materialize} after a child returned a Promise.
   * Finishes remaining child fibers with `await`, then completes wiring / lifecycle.
   *
   * @param {RuntimeFiber<P>} fiber - current fiber
   * @param {Component<unknown, P>} instance - component instance
   * @param {LifecycleEngine} engine - lifecycle engine
   * @param {VirtualServiceNode<P>} vnode - virtual node
   * @param {VirtualServiceNode[]} childVnodes - all child vnodes
   * @param {ContextScope} childScope - scope for child nodes
   * @param {Promise<RuntimeFiber<unknown>>} pending - Promise for the current child
   * @param {number} pendingIdx - index of the current child
   * @param {boolean} deferLifecycle - parent defer flag from {@link materialize}
   * @returns {Promise<RuntimeFiber<P>>}
   */
  private async continueMaterializeAsync<P>(
    fiber: RuntimeFiber<P>,
    instance: Component<unknown, P>,
    engine: LifecycleEngine,
    vnode: VirtualServiceNode<P>,
    childVnodes: VirtualServiceNode[],
    childScope: ContextScope,
    pending: PromiseLike<RuntimeFiber<unknown>>,
    pendingIdx: number,
    deferLifecycle: boolean,
  ): Promise<RuntimeFiber<P>> {
    const journal = fiber.constructionJournal!;

    try {
      journal.mountedChildren.push(await pending);
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      const rollbackRes = this.rollbackFailedMaterialization(fiber, error);
      if (isThenable(rollbackRes)) {
        await rollbackRes;
      }
      throw error;
    }

    for (let i = pendingIdx + 1; i < childVnodes.length; i++) {
      const childVnode = childVnodes[i] as VirtualServiceNode;

      try {
        const childRes = this.materialize(
          childVnode,
          fiber as RuntimeFiber<unknown>,
          childScope,
          true,
        );
        const resolvedChild = isThenable(childRes) ? await childRes : (childRes as RuntimeFiber<unknown>);
        journal.mountedChildren.push(resolvedChild);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        const rollbackRes = this.rollbackFailedMaterialization(fiber, error);
        if (isThenable(rollbackRes)) {
          await rollbackRes;
        }
        throw error;
      }
    }

    fiber.children = journal.mountedChildren as Fiber[];

    // Mark refBound/refOwner BEFORE commitRef (see sync materialize path).
    if (vnode.ref !== undefined) {
      try {
        journal.refBound = true;
        journal.refOwner = instance;
        this.commitRef(undefined, null, vnode.ref, instance);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        const rollbackRes = this.rollbackFailedMaterialization(fiber, error);
        if (isThenable(rollbackRes)) {
          await rollbackRes;
        }
        throw error;
      }
    }

    // Parent buses were wired before the child loop in materialize(); async continuation
    // must not register handlers a second time.

    return this.completeMaterializeAfterWiring(fiber, instance, engine, deferLifecycle);
  }

  /**
   * Async finalization of {@link materialize} when child fibers were gathered synchronously but {@link LifecycleEngine.runStartup} returned a Promise.
   *
   * @template P node props type
   * @param {RuntimeFiber<P>} fiber - fiber of the subtree root node
   * @param {LifecycleEngine} engine - lifecycle engine for this node
   * @param {PromiseLike<import('./lifecycle').LifecycleTransitionResult>} pendingStartup - Promise of the `runStartup` result
   * @returns {Promise<RuntimeFiber<P>>} ready fiber, or rollback children and rethrow
   */
  private async finalizeMaterializeAsync<P>(
    fiber: RuntimeFiber<P>,
    engine: LifecycleEngine,
    pendingStartup: PromiseLike<import('./lifecycle').LifecycleTransitionResult>,
  ): Promise<RuntimeFiber<P>> {
    const result = await pendingStartup;
    const journal = fiber.constructionJournal!;

    if (!result.ok) {
      const error = result.error instanceof Error ? result.error : new Error(String(result.error));
      const rollbackRes = this.rollbackFailedMaterialization(fiber, error);
      if (isThenable(rollbackRes)) {
        await rollbackRes;
      }
      throw error;
    }

    fiber.lifecycleStatus = engine.getStatus();
    fiber.effectTag = null;
    if (fiber.instance !== null) {
      journal.schedulerHookAttached = true;
      this.injectUpdateHook(fiber.instance, fiber);
    }
    return fiber;
  }


  // ---------------------------------------------------------------------------
  // Reconcile
  // ---------------------------------------------------------------------------

  /**
   * Runs fiber-like reconcile for a single node.
   * If type and key match — UPDATE: update props, reconcile children.
   * If they differ — DELETE the old node, PLACE the new one.
   *
   * @param {RuntimeFiber<P>} current - current fiber
   * @param {VirtualServiceNode<P>} nextVnode - new virtual node
   * @param {RuntimeFiber | null} parentFiber - parent fiber
   * @param {ContextScope} parentScope - parent scope
   * @param {boolean} [deferLifecycle=false] - when true, REPLACE materialize wires buses but
   *   defers onMount until the sibling batch flush in {@link reconcileChildren} (same contract
   *   as PLACE). Root reconcile leaves this false; root REPLACE still wires the replacement
   *   before destroying the victim, then flushes deferred lifecycle itself.
   * @returns {Promise<RuntimeFiber<P>>}
   */
  private reconcileFiber<P>(
    current: RuntimeFiber<P>,
    nextVnode: VirtualServiceNode<P>,
    parentFiber: RuntimeFiber<unknown> | null,
    parentScope: ContextScope,
    deferLifecycle: boolean = false,
  ): RuntimeFiber<P> | Promise<RuntimeFiber<P>> {
    const sameType = current.vnode.type === nextVnode.type;
    const sameKey = (current.vnode.key ?? null) === (nextVnode.key ?? null);

    if (sameType && sameKey) {
      // Reuse deferLifecycle as deferOnUpdate: sibling batches must not run
      // onUpdate (and its publishes) before later PLACE peers wire @On* buses.
      return this.updateFiber(current, nextVnode, parentFiber, parentScope, deferLifecycle);
    }

    // Type or key changed — REPLACE.
    // Collect cleanup errors (ref clear / disposer) so a throwing finalize cannot
    // abort REPLACE and fail-stop the surviving tree — same best-effort contract as unmount.
    //
    // When deferLifecycle is set (child reconcile batch), REPLACE must not run onMount
    // before later sibling buses are wired — otherwise a replaced publisher's mount-time
    // publish is silently dropped by a not-yet-wired PLACE/REPLACE listener beside it.
    // (Victim onUnmount-before-later-PLACE is tracked separately in sibling REPLACE PRs.)
    if (deferLifecycle) {
      const destroyRes = this.destroyFiber(current as RuntimeFiber<unknown>, []);
      if (isThenable(destroyRes)) {
        return destroyRes.then(() => this.materialize(nextVnode, parentFiber, parentScope, true));
      }
      return this.materialize(nextVnode, parentFiber, parentScope, true);
    }

    // Root REPLACE (deferLifecycle=false): nothing else flushes the root, but we still
    // must wire the replacement's @On* handlers before destroying the victim — otherwise
    // victim onUnmount publishes on the shared runtime buses are silently dropped.
    return this.replaceRootWireBeforeDestroy(current, nextVnode, parentFiber, parentScope);
  }

  /**
   * Root REPLACE handoff: materialize the replacement with buses wired and onMount
   * deferred, destroy the victim (so onUnmount can reach new @On* handlers), then flush
   * the replacement's deferred lifecycle. Sibling REPLACE keeps the eager-destroy path
   * via {@link reconcileFiber} `deferLifecycle=true` (covered by open sibling PRs).
   *
   * @param {RuntimeFiber<P>} current - victim root fiber
   * @param {VirtualServiceNode<P>} nextVnode - replacement vnode
   * @param {RuntimeFiber | null} parentFiber - parent fiber (null at root)
   * @param {ContextScope} parentScope - parent scope
   * @returns {RuntimeFiber<P> | Promise<RuntimeFiber<P>>}
   */
  private replaceRootWireBeforeDestroy<P>(
    current: RuntimeFiber<P>,
    nextVnode: VirtualServiceNode<P>,
    parentFiber: RuntimeFiber<unknown> | null,
    parentScope: ContextScope,
  ): RuntimeFiber<P> | Promise<RuntimeFiber<P>> {
    const afterMaterialize = (
      nextFiber: RuntimeFiber<P>,
    ): RuntimeFiber<P> | Promise<RuntimeFiber<P>> => {
      const destroyRes = this.destroyFiber(current as RuntimeFiber<unknown>, []);
      const afterDestroy = (): RuntimeFiber<P> | Promise<RuntimeFiber<P>> => {
        const flushRes = this.flushDeferredLifecycleTree(nextFiber as RuntimeFiber<unknown>);
        if (isThenable(flushRes)) {
          return Promise.resolve(flushRes).then(() => nextFiber);
        }
        return nextFiber;
      };
      if (isThenable(destroyRes)) {
        return destroyRes.then(afterDestroy);
      }
      return afterDestroy();
    };

    const materializeRes = this.materialize(nextVnode, parentFiber, parentScope, true);
    if (isThenable(materializeRes)) {
      return materializeRes.then(afterMaterialize);
    }
    return afterMaterialize(materializeRes);
  }

  /**
   * Updates an existing fiber: applies new props to the instance,
   * calls onUpdate, recursively diffs children.
   *
   * @param {RuntimeFiber<P>} current - current fiber
   * @param {VirtualServiceNode<P>} nextVnode - new virtual node
   * @param {RuntimeFiber | null} parentFiber - parent fiber
   * @param {ContextScope} parentScope - parent scope
   * @returns {Promise<RuntimeFiber<P>>}
   */
  private updateFiber<P>(
    current: RuntimeFiber<P>,
    nextVnode: VirtualServiceNode<P>,
    parentFiber: RuntimeFiber<unknown> | null,
    parentScope: ContextScope,
    deferOnUpdate: boolean = false,
  ): RuntimeFiber<P> | Promise<RuntimeFiber<P>> {
    const instance = current.instance;

    if (instance === null) {
      throw new Error('[Effectable] GraphRuntime: UPDATE on fiber with null instance.');
    }

    const prevProps = instance.props;
    const propsReceiver = (
      instance as Component<unknown, P> & RuntimePropsReceiver<P>
    )[RUNTIME_PROPS_RECEIVER];

    if (typeof propsReceiver === 'function') {
      propsReceiver.call(
        instance as Component<unknown, P> & RuntimePropsReceiver<P>,
        nextVnode.props
      );
    } else {
      instance.props = nextVnode.props;
    }

    // Re-inject context fields when parent scope changed
    let contextChanged = false;
    if (current.scope !== parentScope) {
      try {
        contextChanged = injectContextFields(instance, parentScope);
      } catch (error: unknown) {
        const cleanupResult = this.runFiberFailedCleanup(current as RuntimeFiber<unknown>, error);
        if (isThenable(cleanupResult)) {
          return cleanupResult.then(() => {
            throw error;
          });
        }
        throw error;
      }
    }

    // Build scope for child nodes (ContextProvider may have updated values)
    const childScope = this.buildChildScope(instance, parentScope);

    const propsChanged = prevProps !== instance.props;
    const shouldOnUpdate = (propsChanged || contextChanged) && current.engine.canUpdate();

    // Sibling-batch UPDATE: stash onUpdate until after later PLACE peers wire buses
    // (flushed in reconcileChildren before deferred onMount). Root / non-batch UPDATE
    // runs onUpdate *after* reconcileChildren so same-pass PLACE children are wired.
    if (shouldOnUpdate && deferOnUpdate) {
      current.pendingOnUpdatePrevProps = prevProps;
      current.hasPendingOnUpdate = true;
    }

    // Compose first; only then touch refs. A compose() throw must not leave nextRef
    // bound while fiber.vnode.ref still names the previous ref (fail-stop would miss it).
    let nextChildVnodes: VirtualServiceNode[];
    try {
      nextChildVnodes = this.getChildVnodes(instance, nextVnode.children);
    } catch (error: unknown) {
      const cleanupResult = this.runFiberFailedCleanup(current as RuntimeFiber<unknown>, error);
      if (isThenable(cleanupResult)) {
        return cleanupResult.then(() => {
          throw error;
        });
      }
      throw error;
    }

    // Commit the UPDATE ref *before* child reconcile so same-pass PLACE children
    // see parent nextRef in onMount (mount path already commits before deferred
    // onMount flush). Child-reconcile failure must roll the commit back: fiber.vnode
    // still holds previousRef until applyFiberUpdate, so fail-stop would otherwise
    // clear only the old ref and leave a zombie nextRef.
    const previousRef = current.vnode.ref;
    const nextRef = nextVnode.ref;
    let refCommittedBeforeChildren = false;
    try {
      this.commitRef(previousRef, instance, nextRef, instance);
      refCommittedBeforeChildren = true;
    } catch (error: unknown) {
      // commitRef clears nextRef on assign-then-throw; no PLACE orphans yet.
      const cleanupResult = this.runFiberFailedCleanup(current as RuntimeFiber<unknown>, error);
      if (isThenable(cleanupResult)) {
        return cleanupResult.then(() => {
          throw error;
        });
      }
      throw error;
    }

    const rollbackEarlyRefCommit = (): void => {
      if (!refCommittedBeforeChildren) {
        return;
      }
      if (nextRef !== undefined && nextRef !== previousRef) {
        try {
          this.clearRefSafe(nextRef, instance);
        } catch {
          // Best-effort: do not mask the child-reconcile error.
        }
      }
      if (previousRef !== undefined && previousRef !== nextRef) {
        try {
          previousRef.current = this.resolveRefCurrentValue(instance);
        } catch {
          // Best-effort restore before fail-stop clears previousRef.
        }
      }
    };

    let childrenRes: RuntimeFiber<unknown>[] | Promise<RuntimeFiber<unknown>[]>;
    try {
      childrenRes = this.reconcileChildren(
        current.children as RuntimeFiber<unknown>[],
        nextChildVnodes,
        current as RuntimeFiber<unknown>,
        childScope,
      );
    } catch (error: unknown) {
      rollbackEarlyRefCommit();
      throw error;
    }

    const afterChildren = (nextChildren: RuntimeFiber<unknown>[]): RuntimeFiber<P> | Promise<RuntimeFiber<P>> => {
      if (shouldOnUpdate && !deferOnUpdate) {
        try {
          instance.onUpdate(prevProps, instance.props);
        } catch (error: unknown) {
          const cleanupResult = this.runFiberFailedCleanup(current as RuntimeFiber<unknown>, error);
          if (isThenable(cleanupResult)) {
            return cleanupResult.then(() => {
              throw error;
            });
          }
          throw error;
        }
      }

      try {
        this.applyFiberUpdate(current, nextVnode, parentFiber, parentScope, nextChildren);
      } catch (error: unknown) {
        // Children already PLACE/UPDATE/DELETE'd. A throwing applyFiberUpdate leaves
        // PLACE/REPLACE fibers unreachable from current.children — failStop cannot
        // reclaim them. Tear them down before rethrowing (HOLE 3 sibling).
        const orphanRes = this.destroyOrphanedPlacedChildren(
          current.children as RuntimeFiber<unknown>[],
          nextChildren,
          error,
        );
        if (isThenable(orphanRes)) {
          return Promise.resolve(orphanRes).then(() => {
            throw error;
          });
        }
        throw error;
      }
      return current;
    };

    if (isThenable(childrenRes)) {
      return childrenRes.then(
        (nextChildren) => {
          try {
            return afterChildren(nextChildren);
          } catch (error: unknown) {
            const orphanRes = this.destroyOrphanedPlacedChildren(
              current.children as RuntimeFiber<unknown>[],
              nextChildren,
              error,
            );
            if (isThenable(orphanRes)) {
              return orphanRes.then(() => {
                throw error;
              });
            }
            throw error;
          }
        },
        (error: unknown) => {
          rollbackEarlyRefCommit();
          throw error;
        },
      );
    }

    return afterChildren(childrenRes);
  }

  /**
   * Fiber cleanup after update/compose error: destroy children first (children → parent),
   * then `runFailedCleanup` + bus dispose. Does not leave the node in `ready`.
   * Child destroy / disposer errors are attached to `primaryError.rollbackErrors` when provided
   * so fail-stop observability still surfaces them (children are no longer destroyed in failStop).
   *
   * @param {RuntimeFiber<unknown>} fiber - fiber that failed
   * @param {unknown} [primaryError] - originating error to attach cleanup failures onto
   * @returns {void | Promise<void>}
   */
  private runFiberFailedCleanup (
    fiber: RuntimeFiber<unknown>,
    primaryError?: unknown,
  ): void | Promise<void> {
    const instance = fiber.instance;
    if (instance === null) {
      return;
    }

    this.clearUpdateHook(instance);
    this.dirtyFibers.delete(fiber);

    const cleanupErrors: Error[] = [];
    const children = fiber.children as RuntimeFiber<unknown>[];

    const attachCleanupErrors = (): void => {
      if (
        cleanupErrors.length > 0 &&
        primaryError instanceof Error
      ) {
        const existing = (primaryError as Error & { rollbackErrors?: Error[] }).rollbackErrors;
        (primaryError as Error & { rollbackErrors?: Error[] }).rollbackErrors =
          existing !== undefined ? existing.concat(cleanupErrors) : cleanupErrors.slice();
      }
    };

    const finishParent = (): void | Promise<void> => {
      this.setFiberChildren(fiber, []);
      const cleanupResult = fiber.engine.runFailedCleanup(instance, true);
      if (isThenable(cleanupResult)) {
        return cleanupResult.then(
          () => {
            this.disposeEffectableRuntimeBusWiring(fiber);
            fiber.lifecycleStatus = fiber.engine.getStatus();
            attachCleanupErrors();
          },
          (err: unknown) => {
            cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
            this.disposeEffectableRuntimeBusWiring(fiber);
            fiber.lifecycleStatus = fiber.engine.getStatus();
            attachCleanupErrors();
            throw err;
          },
        );
      }

      this.disposeEffectableRuntimeBusWiring(fiber);
      fiber.lifecycleStatus = fiber.engine.getStatus();
      attachCleanupErrors();
    };

    // Siblings in compose order — same contract as destroyFiber / clean unmount.
    for (let i = 0; i < children.length; i += 1) {
      try {
        const destroyRes = this.destroyFiber(children[i] as RuntimeFiber<unknown>, cleanupErrors);
        if (isThenable(destroyRes)) {
          return destroyRes.then(
            async () => {
              for (let j = i + 1; j < children.length; j += 1) {
                try {
                  const r = this.destroyFiber(children[j] as RuntimeFiber<unknown>, cleanupErrors);
                  if (isThenable(r)) {
                    await r;
                  }
                } catch (err: unknown) {
                  cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
                }
              }
              return finishParent();
            },
            async (err: unknown) => {
              cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
              for (let j = i + 1; j < children.length; j += 1) {
                try {
                  const r = this.destroyFiber(children[j] as RuntimeFiber<unknown>, cleanupErrors);
                  if (isThenable(r)) {
                    await r;
                  }
                } catch (inner: unknown) {
                  cleanupErrors.push(inner instanceof Error ? inner : new Error(String(inner)));
                }
              }
              return finishParent();
            },
          );
        }
      } catch (err: unknown) {
        cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    return finishParent();
  }

  /**
   * Destroys PLACE/REPLACE fibers in `nextChildren` that are not identity-in `currentChildren`.
   * Used when child reconcile succeeded but a later step (e.g. ref commit in
   * {@link applyFiberUpdate}) throws — those new fibers are not linked onto the parent
   * yet, so fail-stop teardown of `currentRoot` cannot reach them.
   *
   * @param {RuntimeFiber<unknown>[]} currentChildren - parent children before apply
   * @param {RuntimeFiber<unknown>[]} nextChildren - reconciled next children
   * @param {unknown} primaryError - error to attach rollback failures onto
   * @returns {void | Promise<void>}
   */
  private destroyOrphanedPlacedChildren (
    currentChildren: RuntimeFiber<unknown>[],
    nextChildren: RuntimeFiber<unknown>[],
    primaryError: unknown,
  ): void | Promise<void> {
    const currentChildrenSet = new Set(currentChildren);
    const rollbackErrors: Error[] = [];

    const attachRollbackErrors = (): void => {
      if (rollbackErrors.length === 0 || !(primaryError instanceof Error)) {
        return;
      }
      const existing = (primaryError as Error & { rollbackErrors?: Error[] }).rollbackErrors;
      (primaryError as Error & { rollbackErrors?: Error[] }).rollbackErrors =
        existing !== undefined ? existing.concat(rollbackErrors) : rollbackErrors.slice();
    };

    for (let i = 0; i < nextChildren.length; i += 1) {
      const child = nextChildren[i] as RuntimeFiber<unknown>;
      if (currentChildrenSet.has(child)) {
        continue;
      }
      try {
        const destroyRes = this.destroyFiber(child, rollbackErrors);
        if (isThenable(destroyRes)) {
          return destroyRes.then(
            async () => {
              for (let j = i + 1; j < nextChildren.length; j += 1) {
                const rest = nextChildren[j] as RuntimeFiber<unknown>;
                if (currentChildrenSet.has(rest)) {
                  continue;
                }
                try {
                  const r = this.destroyFiber(rest, rollbackErrors);
                  if (isThenable(r)) {
                    await r;
                  }
                } catch (err: unknown) {
                  rollbackErrors.push(err instanceof Error ? err : new Error(String(err)));
                }
              }
              attachRollbackErrors();
            },
            async (err: unknown) => {
              rollbackErrors.push(err instanceof Error ? err : new Error(String(err)));
              for (let j = i + 1; j < nextChildren.length; j += 1) {
                const rest = nextChildren[j] as RuntimeFiber<unknown>;
                if (currentChildrenSet.has(rest)) {
                  continue;
                }
                try {
                  const r = this.destroyFiber(rest, rollbackErrors);
                  if (isThenable(r)) {
                    await r;
                  }
                } catch (inner: unknown) {
                  rollbackErrors.push(inner instanceof Error ? inner : new Error(String(inner)));
                }
              }
              attachRollbackErrors();
            },
          );
        }
      } catch (err: unknown) {
        rollbackErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    attachRollbackErrors();
  }

  /**
   * Applies the reconcile result to the current fiber in-place.
   * In-place mutation instead of spread: 0 heap allocations on UPDATE
   * (3.09x speedup). Safe: RuntimeFiber is private.
   *
   * @param {RuntimeFiber<P>} current - current fiber
   * @param {VirtualServiceNode<P>} nextVnode - new vnode
   * @param {RuntimeFiber<unknown> | null} parentFiber - parent fiber
   * @param {ContextScope} parentScope - parent scope
   * @param {RuntimeFiber<unknown>[]} nextChildren - new child fibers
   * @returns {void}
   */
  /**
   * Applies the reconcile result to the current fiber in-place.
   * In-place mutation instead of spread: 0 heap allocations on UPDATE
   * (3.09x speedup). Safe: RuntimeFiber is private.
   *
   * @param {RuntimeFiber<P>} current - current fiber
   * @param {VirtualServiceNode<P>} nextVnode - new vnode
   * @param {RuntimeFiber<unknown> | null} parentFiber - parent fiber
   * @param {ContextScope} parentScope - parent scope
   * @param {RuntimeFiber<unknown>[]} nextChildren - new child fibers
   * @returns {void}
   */
  private applyFiberUpdate<P> (
    current: RuntimeFiber<P>,
    nextVnode: VirtualServiceNode<P>,
    parentFiber: RuntimeFiber<unknown> | null,
    parentScope: ContextScope,
    nextChildren: RuntimeFiber<unknown>[],
  ): void {
    // Ref already committed in updateFiber after compose and before child
    // reconcile (so PLACE onMount observes parent nextRef). Only publish the
    // fiber bookkeeping here.
    current.vnode = nextVnode;
    current.parentFiber = parentFiber as RuntimeFiber<unknown> | null;
    this.setFiberChildren(current as RuntimeFiber<unknown>, nextChildren as Fiber[]);
    current.effectTag = FIBER_EFFECT_TAG.UPDATE;
    current.scope = parentScope;
    current.lifecycleStatus = current.engine.getStatus();
  }

  /**
   * Diffs children: matches current and next child nodes by key+type.
   * Nodes without a key are matched by position.
   * Extra current nodes — DELETE; new unpaired nodes — PLACE.
   *
   * Optimizations:
   * - isStableChildren fast-path (9.31x): if children are stable (N≤32, same type+key) — indexed loop without Map.
   * - Skip keyedCurrentMap (6.06x): if there are no keyed children — do not create a Map at all.
   * - Depth-indexed Map pool (5.1x): with keyed children, reuse Map via clear() instead of new Map().
   *
   * @param {RuntimeFiber[]} currentChildren - current child fibers
   * @param {VirtualServiceNode[]} nextVnodes - new child virtual nodes
   * @param {RuntimeFiber} parentFiber - parent fiber
   * @param {ContextScope} childScope - scope for child nodes
   * @returns {Promise<RuntimeFiber[]>}
   */
  private reconcileChildren (
    currentChildren: RuntimeFiber<unknown>[],
    nextVnodes: VirtualServiceNode[],
    parentFiber: RuntimeFiber<unknown>,
    childScope: ContextScope,
  ): RuntimeFiber<unknown>[] | Promise<RuntimeFiber<unknown>[]> {
    // === FAST PATH: stable children (N≤32, same type+key per position) ===
    // 9.31x speedup vs full diff for stable trees (typical HFT scenario)
    if (this.isStableChildren(currentChildren, nextVnodes)) {
      const n = nextVnodes.length;
      const stableResult: RuntimeFiber<unknown>[] = [];

      for (let i = 0; i < n; i++) {
        const reconciled = this.reconcileFiber(
          currentChildren[i] as RuntimeFiber<unknown>,
          nextVnodes[i] as VirtualServiceNode<unknown>,
          parentFiber,
          childScope,
          true,
        );

        if (isThenable(reconciled)) {
          return this.continueStableReconcileAsync(
            stableResult, reconciled, i, nextVnodes, currentChildren, parentFiber, childScope,
          );
        }

        stableResult.push(reconciled);
      }

      const batchFlush = this.flushSiblingBatchHooks(stableResult);
      if (isThenable(batchFlush)) {
        return Promise.resolve(batchFlush).then(() => stableResult);
      }

      return stableResult;
    }

    // === FULL DIFF PATH — always async (complex logic; sync path not optimized here) ===
    return this.reconcileChildrenFullDiff(currentChildren, nextVnodes, parentFiber, childScope);
  }

  /**
   * Async continuation of the stable fast-path reconcile after an async child.
   *
   * @param {RuntimeFiber<unknown>[]} resultSoFar - already gathered sync children
   * @param {PromiseLike<RuntimeFiber<unknown>>} pending - Promise for the current child
   * @param {number} pendingIdx - index of the pending child
   * @param {VirtualServiceNode[]} nextVnodes - all new vnodes
   * @param {RuntimeFiber<unknown>[]} currentChildren - all current fibers
   * @param {RuntimeFiber<unknown>} parentFiber - parent fiber
   * @param {ContextScope} childScope - children scope
   * @returns {Promise<RuntimeFiber<unknown>[]>}
   */
  private async continueStableReconcileAsync (
    resultSoFar: RuntimeFiber<unknown>[],
    pending: PromiseLike<RuntimeFiber<unknown>>,
    pendingIdx: number,
    nextVnodes: VirtualServiceNode[],
    currentChildren: RuntimeFiber<unknown>[],
    parentFiber: RuntimeFiber<unknown>,
    childScope: ContextScope,
  ): Promise<RuntimeFiber<unknown>[]> {
    this.stableAsyncContinueCount += 1;
    resultSoFar.push(await pending);

    for (let i = pendingIdx + 1; i < nextVnodes.length; i++) {
      const reconciled = this.reconcileFiber(
        currentChildren[i] as RuntimeFiber<unknown>,
        nextVnodes[i] as VirtualServiceNode<unknown>,
        parentFiber,
        childScope,
        true,
      );
      resultSoFar.push(isThenable(reconciled) ? await reconciled : (reconciled as RuntimeFiber<unknown>));
    }

    const batchFlush = this.flushSiblingBatchHooks(resultSoFar);
    if (isThenable(batchFlush)) {
      await batchFlush;
    }

    return resultSoFar;
  }

  /**
   * Validates that sibling keys are unique within a list.
   * Follows React v16.5 keyed child reconciliation contract: duplicate keys are invalid.
   * Throws a descriptive error including the duplicate key and parent component identity.
   *
   * @param {Array<{ vnode: { key?: string }; instance?: Component<unknown, unknown> | null }>} items - list of fibers or vnodes
   * @param {RuntimeFiber<unknown>} parentFiber - parent fiber (for error message)
   * @param {string} listName - "current" or "next" (for error message)
   * @returns {void}
   * @throws {Error} when duplicate keys are detected
   */
  private validateUniqueKeys (
    items: Array<{ vnode: { key?: string }; instance?: Component<unknown, unknown> | null }>,
    parentFiber: RuntimeFiber<unknown>,
    listName: string,
  ): void {
    const seenKeys = new Set<string>();
    
    for (const item of items) {
      const key = item.vnode.key;
      
      if (key !== undefined) {
        if (seenKeys.has(key)) {
          const parentInstance = parentFiber.instance;
          const parentName = parentInstance !== null 
            ? parentInstance.constructor.name 
            : 'unknown';
          
          throw new Error(
            `[Effectable] GraphRuntime: duplicate key "${key}" in ${listName} children of ${parentName}. ` +
            `Sibling keys must be unique (React v16.5 keyed child reconciliation contract). ` +
            `Duplicates cause undefined matching behavior and lifecycle leaks.`
          );
        }
        
        seenKeys.add(key);
      }
    }
  }

  /**
   * Full-diff reconcile: keyed/unkeyed Map + destroy orphans.
   * Always async — internal branching is too complex for an efficient sync path.
   *
   * Contract: Sibling keys must be unique (React v16.5 keyed child reconciliation).
   * Validates both current and next children BEFORE any side effects.
   * Throws deterministic error on duplicate keys to prevent lifecycle leaks.
   *
   * HOLE 3: On throw during PLACE, cleans up previously placed new nodes
   * to prevent lifecycle leaks. Uses identity-safe check against currentChildren Set.
   *
   * @param {RuntimeFiber<unknown>[]} currentChildren - current child fibers
   * @param {VirtualServiceNode[]} nextVnodes - new vnodes
   * @param {RuntimeFiber<unknown>} parentFiber - parent fiber
   * @param {ContextScope} childScope - children scope
   * @returns {Promise<RuntimeFiber<unknown>[]>}
   * @throws {Error} when duplicate keys are detected in current or next children
   */
  private async reconcileChildrenFullDiff (
    currentChildren: RuntimeFiber<unknown>[],
    nextVnodes: VirtualServiceNode[],
    parentFiber: RuntimeFiber<unknown>,
    childScope: ContextScope,
  ): Promise<RuntimeFiber<unknown>[]> {
    // Validate unique keys BEFORE any side effects (Option A: React v16.5 contract)
    this.validateUniqueKeys(currentChildren, parentFiber, 'current');
    this.validateUniqueKeys(
      nextVnodes.map(vnode => ({ vnode, instance: null })),
      parentFiber,
      'next'
    );

    // HOLE 3: Build identity Set of currentChildren for rollback
    // Used to distinguish UPDATE (same object) from PLACE/REPLACE (new object)
    const currentChildrenSet = new Set(currentChildren);

    // Check for keyed children before creating a Map (6.06x speedup for unkeyed-only)
    let hasKeyedCurrent = false;

    for (const child of currentChildren) {
      if (child.vnode.key !== undefined) {
        hasKeyedCurrent = true;
        break;
      }
    }

    const unkeyedCurrent: RuntimeFiber<unknown>[] = [];
    const nextChildren: RuntimeFiber<unknown>[] = [];
    let unkeyedIdx = 0;

    // Release orphan exclusive Command/Query slots BEFORE any PLACE materialize.
    // Those buses allow only one handler per type: PLACE `@OnCommand`/`@OnQuery` for a
    // type still owned by a not-yet-destroyed orphan throws and fail-stops.
    // Walk the orphan *subtree* — exclusive handlers often live on nested children under
    // a keyed wrapper (#170). Keep `@OnEvent` subscriptions until destroy — deferred
    // sibling UPDATE may still publish into the orphan before onUnmount (#158).
    if (this.effectableRuntimeBuses !== null) {
      const buses = this.effectableRuntimeBuses;
      for (const orphan of this.collectFullDiffOrphans(currentChildren, nextVnodes, hasKeyedCurrent)) {
        try {
          this.releaseExclusiveRuntimeBusHandlersSubtree(orphan, buses);
        } catch {
          // Best-effort: a throwing unregister must not skip remaining orphans or block PLACE.
          // destroyFiber still runs the full bus disposer later.
        }
      }
    }

    // Pass-1 defers same-type UPDATE until after PLACE/REPLACE siblings are wired.
    // Otherwise UPDATE `onUpdate` can publish before a later PLACE sibling's `@On*`
    // handlers exist — silent event loss (same class as #108 onMount/PLACE ordering).
    const pendingUpdates: Array<{
      slot: number;
      current: RuntimeFiber<unknown>;
      nextVnode: VirtualServiceNode<unknown>;
    }> = [];

    // Orphan DELETE must run *after* deferred UPDATEs (pass 2). #119 moved orphan
    // destroy before pass 2 so PLACE could wire first, but that also ran sibling
    // onUnmount before UPDATE onUpdate — silent handoff loss / stale props on the
    // surviving listener. Collect orphans here; release the keyed Map before pass 2.
    const pendingOrphans: RuntimeFiber<unknown>[] = [];

    /**
     * Same type+key → schedule UPDATE for pass 2; otherwise REPLACE with deferred startup.
     *
     * @param {RuntimeFiber<unknown>} currentFiber - matched current fiber
     * @param {VirtualServiceNode<unknown>} nextVnode - next vnode
     * @returns {Promise<void>}
     */
    const enqueueMatchedSibling = async (
      currentFiber: RuntimeFiber<unknown>,
      nextVnode: VirtualServiceNode<unknown>,
    ): Promise<void> => {
      const sameType = currentFiber.vnode.type === nextVnode.type;
      const sameKey = (currentFiber.vnode.key ?? null) === (nextVnode.key ?? null);

      if (sameType && sameKey) {
        pendingUpdates.push({
          slot: nextChildren.length,
          current: currentFiber,
          nextVnode,
        });
        // Placeholder identity keeps rollback classification correct until pass 2.
        nextChildren.push(currentFiber);
        return;
      }

      const reconciledRes = this.reconcileFiber(
        currentFiber,
        nextVnode,
        parentFiber,
        childScope,
        true,
      );
      nextChildren.push(isThenable(reconciledRes) ? await reconciledRes : reconciledRes);
    };

    try {
      if (hasKeyedCurrent) {
        // Acquire Map from the depth-indexed pool (5.1x: Map.clear() vs new Map())
        const keyedCurrentMap = this.acquireKeyedMap();
        this.reconcileDepth++;

        try {
          // Build map of current children by key (for keyed matching)
          for (const child of currentChildren) {
            const key = child.vnode.key;

            if (key !== undefined) {
              keyedCurrentMap.set(key, child);
            } else {
              unkeyedCurrent.push(child);
            }
          }

          for (const nextVnode of nextVnodes) {
            const nextKey = nextVnode.key;

            if (nextKey !== undefined && keyedCurrentMap.has(nextKey)) {
              const currentFiber = keyedCurrentMap.get(nextKey);

              if (currentFiber === undefined) {
                throw new Error(`[Effectable] GraphRuntime: fiber with key "${nextKey}" not found in map.`);
              }

              keyedCurrentMap.delete(nextKey);
              await enqueueMatchedSibling(
                currentFiber,
                nextVnode as VirtualServiceNode<unknown>,
              );
            } else if (nextKey === undefined && unkeyedIdx < unkeyedCurrent.length) {
              const currentFiber = unkeyedCurrent[unkeyedIdx];
              unkeyedIdx += 1;

              await enqueueMatchedSibling(
                currentFiber as RuntimeFiber<unknown>,
                nextVnode as VirtualServiceNode<unknown>,
              );
            } else {
              // New node — PLACE: defer startup so later sibling buses wire first.
              const newRes = this.materialize(nextVnode, parentFiber, childScope, true);
              nextChildren.push(isThenable(newRes) ? await newRes : newRes);
            }
          }

          // Queue unpaired keyed orphans — destroy after pass-2 UPDATEs (see pendingOrphans).
          for (const [, orphan] of keyedCurrentMap) {
            pendingOrphans.push(orphan);
          }
        } finally {
          this.reconcileDepth--;
          this.releaseKeyedMap();
        }
      } else {
        // No keyed children — skip Map, positional reconcile
        for (const child of currentChildren) {
          unkeyedCurrent.push(child);
        }

        for (const nextVnode of nextVnodes) {
          if (unkeyedIdx < unkeyedCurrent.length) {
            const currentFiber = unkeyedCurrent[unkeyedIdx];
            unkeyedIdx += 1;

            await enqueueMatchedSibling(
              currentFiber as RuntimeFiber<unknown>,
              nextVnode as VirtualServiceNode<unknown>,
            );
          } else {
            // New node — PLACE: defer startup so later sibling buses wire first.
            const newRes = this.materialize(nextVnode, parentFiber, childScope, true);
            nextChildren.push(isThenable(newRes) ? await newRes : newRes);
          }
        }
      }

      // Queue unpaired unkeyed orphans (destroyed after pass-2 UPDATEs).
      for (let i = unkeyedIdx; i < unkeyedCurrent.length; i += 1) {
        const orphan = unkeyedCurrent[i];

        if (orphan !== undefined) {
          pendingOrphans.push(orphan);
        }
      }

      // Pass 2: run deferred UPDATEs. PLACE/REPLACE siblings are already wired, so
      // onUpdate publishes reach new @On* handlers before deferred onMount flush.
      // Orphans remain alive until after this pass so UPDATE↔DELETE handoff keeps
      // pre-#119 order (onUpdate before sibling onUnmount).
      for (const pending of pendingUpdates) {
        const updatedRes = this.updateFiber(
          pending.current,
          pending.nextVnode,
          parentFiber,
          childScope,
        );
        nextChildren[pending.slot] = isThenable(updatedRes) ? await updatedRes : updatedRes;
      }

      // Destroy orphans after UPDATEs (best-effort finalize errors). PLACE peers are
      // already wired, so onUnmount publishes still reach same-batch PLACE @On*.
      for (const orphan of pendingOrphans) {
        const d = this.destroyFiber(orphan, []);
        if (isThenable(d)) {
          await d;
        }
      }

      // Deferred onUpdates first (so UPDATE publishes see wired PLACE @On*), then
      // PLACE/REPLACE startups in compose order after every new sibling is wired.
      const batchFlush = this.flushSiblingBatchHooks(nextChildren);
      if (isThenable(batchFlush)) {
        await batchFlush;
      }

      return nextChildren;
    } catch (primaryError: unknown) {
      // HOLE 3: On throw, clean up new fibers in nextChildren
      // that are NOT identity-in currentChildren (PLACE/REPLACE results).
      // Do not destroy UPDATE siblings (same object as current child).
      const rollbackErrors: Error[] = [];

      for (const child of nextChildren) {
        // Skip if this fiber is identity-in currentChildren (UPDATE, not PLACE/REPLACE)
        if (currentChildrenSet.has(child)) {
          continue;
        }

        // New fiber (PLACE or REPLACE result) — destroy it
        try {
          const d = this.destroyFiber(child, rollbackErrors);
          if (isThenable(d)) {
            await d;
          }
        } catch (err: unknown) {
          rollbackErrors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }

      // Attach rollback errors to primary error (pattern)
      if (rollbackErrors.length > 0) {
        const error = primaryError instanceof Error ? primaryError : new Error(String(primaryError));
        (error as Error & { rollbackErrors?: Error[] }).rollbackErrors = rollbackErrors;
        throw error;
      }

      throw primaryError;
    }
  }

  /**
   * Whether children are stable: same count, same type and key per position.
   * Only for N≤32 — with more children the check does not pay off.
   * When children are stable, reconcileChildren skips the full diff (9.31x speedup).
   *
   * @param {RuntimeFiber<unknown>[]} current - current child fibers
   * @param {VirtualServiceNode[]} next - new child virtual nodes
   * @returns {boolean} true if children are stable and the fast-path may be used
   */
  private isStableChildren (
    current: RuntimeFiber<unknown>[],
    next: VirtualServiceNode[],
  ): boolean {
    const n = current.length;

    if (n !== next.length || n > 32) {
      return false;
    }

    for (let i = 0; i < n; i++) {
      if ((current[i] as RuntimeFiber<unknown>).vnode.type !== (next[i] as VirtualServiceNode).type) {
        return false;
      }

      if (((current[i] as RuntimeFiber<unknown>).vnode.key ?? null) !== ((next[i] as VirtualServiceNode).key ?? null)) {
        return false;
      }
    }

    return true;
  }

  /**
   * Returns a Map from the depth-indexed pool for the current recursion depth.
   * On first visit to a depth — creates a new Map (lazy alloc).
   * Repeated calls at the same depth get an already-cleared Map.
   *
   * @returns {Map<string, RuntimeFiber<unknown>>} Map for the current recursion depth
   */
  private acquireKeyedMap (): Map<string, RuntimeFiber<unknown>> {
    const depth = this.reconcileDepth;

    if (depth >= this.keyedMapPool.length) {
      this.keyedMapPool.push(new Map());
    }

    return this.keyedMapPool[depth] as Map<string, RuntimeFiber<unknown>>;
  }

  /**
   * Clears the Map for the current recursion depth and returns it to the pool.
   * Called in finally after the keyed diff completes.
   *
   * @returns {void}
   */
  private releaseKeyedMap (): void {
    (this.keyedMapPool[this.reconcileDepth] as Map<string, RuntimeFiber<unknown>>).clear();
  }

  // ---------------------------------------------------------------------------
  // Destroy
  // ---------------------------------------------------------------------------

  /**
   * Unmounts a fiber and its entire subtree.
   * Order: children first (recursively), then the parent.
   * Afterward: clears ref.current.
   *
   * Returns `void` synchronously if the whole subtree is sync (up to 266x speedup
   * on an 85-node tree); otherwise a Promise. `await` works correctly with either union branch.
   *
   * Collects cleanup errors via `collectErrors` parameter (best-effort cleanup).
   *
   * @param {RuntimeFiber} fiber - fiber to destroy
   * @param {Error[] | null} collectErrors - array to collect cleanup errors (null to throw immediately)
   * @returns {void | Promise<void>}
   */
  private destroyFiber (fiber: RuntimeFiber<unknown>, collectErrors: Error[] | null = null): void | Promise<void> {
    const children = fiber.children;
    const n = children.length;

    // Sync recursion over children until the first async
    for (let i = 0; i < n; i++) {
      try {
        const childRes = this.destroyFiber(children[i] as RuntimeFiber<unknown>, collectErrors);
        if (isThenable(childRes)) {
          return this.continueDestroyAsync(fiber, children, i, childRes, collectErrors);
        }
      } catch (err: unknown) {
        // Best-effort cleanup — collect error and continue
        if (collectErrors !== null) {
          collectErrors.push(err instanceof Error ? err : new Error(String(err)));
        } else {
          throw err;
        }
      }
    }

    const instance = fiber.instance;
    if (instance === null) {
      return;
    }

    this.clearUpdateHook(instance);
    this.dirtyFibers.delete(fiber);

    const shutdownRes = fiber.engine.runShutdown(instance);
    if (isThenable(shutdownRes)) {
      return this.finalizeDestroyAsync(fiber, shutdownRes, collectErrors);
    }

    // Collect shutdown errors for observability
    if (!shutdownRes.ok) {
      if (collectErrors !== null) {
        collectErrors.push(shutdownRes.error instanceof Error ? shutdownRes.error : new Error(String(shutdownRes.error)));
      }
    }

    // Always finalize the fiber even if shutdown failed (best-effort cleanup)
    // finalizeFiberDestroy uses commitRef for identity-safe ref clearing
    this.finalizeFiberDestroy(fiber, collectErrors);
  }

  /**
   * Async continuation of {@link destroyFiber} after one of the children returned a Promise.
   *
   * @param {RuntimeFiber<unknown>} fiber - current fiber
   * @param {Fiber[]} children - children list
   * @param {number} pendingIdx - index of the pending child
   * @param {PromiseLike<void>} pending - Promise from destroying the child
   * @param {Error[] | null} collectErrors - array to collect cleanup errors
   * @returns {Promise<void>}
   */
  private async continueDestroyAsync (
    fiber: RuntimeFiber<unknown>,
    children: Fiber[],
    pendingIdx: number,
    pending: PromiseLike<void>,
    collectErrors: Error[] | null = null,
  ): Promise<void> {
    // Best-effort cleanup — await pending child
    try {
      await pending;
    } catch (err: unknown) {
      if (collectErrors !== null) {
        collectErrors.push(err instanceof Error ? err : new Error(String(err)));
      } else {
        throw err;
      }
    }

    // Continue destroying remaining children even if previous failed
    for (let i = pendingIdx + 1; i < children.length; i++) {
      try {
        const r = this.destroyFiber(children[i] as RuntimeFiber<unknown>, collectErrors);
        if (isThenable(r)) {
          await r;
        }
      } catch (err: unknown) {
        if (collectErrors !== null) {
          collectErrors.push(err instanceof Error ? err : new Error(String(err)));
        } else {
          throw err;
        }
      }
    }

    const instance = fiber.instance;
    if (instance === null) {
      return;
    }

    this.clearUpdateHook(instance);
    this.dirtyFibers.delete(fiber);

    const shutdownRes = fiber.engine.runShutdown(instance);
    if (isThenable(shutdownRes)) {
      const asyncRes = await shutdownRes;
      if (typeof asyncRes === 'object' && asyncRes !== null && 'ok' in asyncRes && !asyncRes.ok) {
        if (collectErrors !== null) {
          collectErrors.push(asyncRes.error instanceof Error ? asyncRes.error : new Error(String(asyncRes.error)));
        }
      }
    } else if (!shutdownRes.ok) {
      if (collectErrors !== null) {
        collectErrors.push(shutdownRes.error instanceof Error ? shutdownRes.error : new Error(String(shutdownRes.error)));
      }
    }

    // Always finalize even if shutdown failed
    // finalizeFiberDestroy uses commitRef for identity-safe ref clearing
    this.finalizeFiberDestroy(fiber, collectErrors);
  }

  /**
   * Async finalization of {@link destroyFiber} when children were destroyed synchronously
   * but `runShutdown` returned a Promise.
   *
   * @param {RuntimeFiber<unknown>} fiber
   * @param {PromiseLike<unknown>} pendingShutdown
   * @param {Error[] | null} collectErrors - array to collect cleanup errors
   * @returns {Promise<void>}
   */
  private async finalizeDestroyAsync (
    fiber: RuntimeFiber<unknown>,
    pendingShutdown: PromiseLike<unknown>,
    collectErrors: Error[] | null = null,
  ): Promise<void> {
    const shutdownRes = await pendingShutdown;

    // Collect shutdown errors for observability
    if (typeof shutdownRes === 'object' && shutdownRes !== null && 'ok' in shutdownRes && !shutdownRes.ok) {
      if (collectErrors !== null) {
        const err = (shutdownRes as { ok: false; error: unknown }).error;
        collectErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // Always finalize even if shutdown failed
    // finalizeFiberDestroy uses commitRef for identity-safe ref clearing
    this.finalizeFiberDestroy(fiber, collectErrors);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * Returns the list of child VirtualServiceNode: first from the instance's compose(),
   * then from explicit vnode children (fallback).
   *
   * @param {Component<unknown, unknown>} instance - component instance
   * @param {VirtualServiceNode[]} explicitChildren - children from vnode.children
   * @returns {VirtualServiceNode[]}
   */
  private getChildVnodes (
    instance: Component<unknown, unknown>,
    explicitChildren: VirtualServiceNode[],
  ): VirtualServiceNode[] {
    if (typeof instance.compose !== 'function') {
      return explicitChildren;
    }

    const composed = instance.compose();

    if (composed === null) {
      return [];
    }

    if (Array.isArray(composed)) {
      return composed;
    }

    return [composed];
  }

  /**
   * Builds the child scope: if the instance is a ContextProvider — extends the scope with its values.
   *
   * @param {Component<unknown, unknown>} instance - component instance
   * @param {ContextScope} parentScope - parent scope
   * @returns {ContextScope}
   */
  private buildChildScope (
    instance: Component<unknown, unknown>,
    parentScope: ContextScope,
  ): ContextScope {
    // Symbol flag instead of instanceof: 1.90x speedup on the negative path (ordinary components)
    if ((instance as unknown as Record<symbol, unknown>)[IS_CONTEXT_PROVIDER] === true) {
      return (instance as unknown as ContextProvider).applyToScope(parentScope);
    }

    return parentScope;
  }
}

// ---------------------------------------------------------------------------
// effectTag types (re-export for convenience)
// ---------------------------------------------------------------------------

/**
 * Creates a node effectTag from a situation (identity helper for {@link FiberEffectTag}).
 *
 * @param {FiberEffectTag} tag - value from {@link FIBER_EFFECT_TAG} or null
 * @returns {FiberEffectTag}
 */
export function makeFiberEffectTag (tag: FiberEffectTag): FiberEffectTag {
  return tag;
}
