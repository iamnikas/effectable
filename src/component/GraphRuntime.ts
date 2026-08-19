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
 * - Serialize all graph operations through a single operation queue (issue #11).
 * - Fail-stop on unrecoverable errors: mark runtime FAILED, reject later reconcile,
 *   unmount stays safe (issue #10).
 *
 * Current limitations:
 * - Work loop is synchronous (no priority lanes — next increment).
 * - Component.setState() and connect selector updates schedule automatic subtree reconcile
 *   via a dirty-fiber queue with microtask coalescing; manual reconcile remains a force-update API.
 * - ContextProvider is handled as a special case in buildScope.
 *
 * @module Effectable/component/GraphRuntime
 */

import type { Component } from './Component';
import type {
  Fiber,
  FiberEffectTag,
  FiberInspectNode,
  RefObject,
  RuntimePropsReceiver,
  VirtualServiceNode,
} from './types';
import { FIBER_EFFECT_TAG, RUNTIME_PROPS_RECEIVER, SCHEDULE_UPDATE_HOOK } from './types';
import { LifecycleEngine } from './lifecycle';
import {
  ContextProvider,
  EMPTY_CONTEXT_SCOPE,
  injectContextFields,
  IS_CONTEXT_PROVIDER,
} from './context';
import type { ContextScope } from './context';
import type {
  RuntimeCommand,
  RuntimeEvent,
  RuntimeQuery,
} from '../runtime/types';
import type { RuntimeBusesBundle } from '../runtime/BusDecorators';
import { wireRuntimeBusesIfDecorated } from '../runtime/BusDecorators';
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
// Runtime state machine (issue #10)
// ---------------------------------------------------------------------------

/**
 * Runtime state literals (issue #10).
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
 * On failure, resources are released in reverse acquisition order (issue #12).
 */
interface FiberConstructionJournal {
  /** Scheduler hook injection step completed. */
  schedulerHookAttached?: boolean;
  /** Runtime bus wiring step completed. */
  busWiringAttached?: boolean;
  /** Ref binding step completed. */
  refBound?: boolean;
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
   * Used for transactional rollback on failure (issue #12).
   */
  constructionJournal?: FiberConstructionJournal;
}

// ---------------------------------------------------------------------------
// GraphRuntime
// ---------------------------------------------------------------------------

/**
 * Runtime engine for a declarative component tree.
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
   * Runtime state machine (issue #10).
   * IDLE → ACTIVE (on mount) → FAILED | UNMOUNTING → UNMOUNTED.
   * FAILED is terminal: subsequent reconcile rejects, unmount is safe.
   */
  private state: RuntimeState = RUNTIME_STATE.IDLE;

  /**
   * Terminal error captured by failStop() (issue #10).
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
   * Operation queue: serializes reconcile and unmount (issue #11).
   * Each operation is a Promise-returning function executed sequentially.
   */
  private operationQueue: Array<() => Promise<void>> = [];

  /**
   * Whether an operation is currently running.
   */
  private operationInProgress = false;

  /**
   * Cached unmount promise for concurrent unmount callers (issue #11).
   */
  private cachedUnmountPromise: Promise<void> | null = null;

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
   * Issue #10: no failed reconcile leaves the runtime active with a partial graph.
   * Issue #12 primary-error rules: cleanup errors attached as rollbackErrors, never replace primary.
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
    // MUST set currentRoot = null even if destroyFiber throws (issue #12)
    if (this.currentRoot !== null) {
      const root = this.currentRoot;
      this.currentRoot = null;
      
      // Collect cleanup errors during fail-stop (issue #12: attach as rollbackErrors)
      const cleanupErrors: Error[] = [];
      const destroyRes = this.destroyFiber(root, cleanupErrors);
      
      if (isThenable(destroyRes)) {
        // Async path: attach cleanup errors after completion
        return destroyRes.then(() => {
          if (cleanupErrors.length > 0) {
            (error as Error & { rollbackErrors?: Error[] }).rollbackErrors = cleanupErrors;
          }
        });
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
   * Identity-safe ref clearing: clears ref.current only if it still points to the expected owner.
   * Prevents an old rollback from clearing a ref that a newer materialization already reused.
   * Partial foundation for #17 (complete decorator-backed ref storage is out of scope for #12).
   *
   * @param {RefObject<unknown>} ref - ref object
   * @param {Component<unknown, unknown>} expectedOwner - expected current owner
   * @returns {void}
   */
  private clearRefSafe (ref: RefObject<unknown>, expectedOwner: Component<unknown, unknown>): void {
    if (ref.current === expectedOwner) {
      ref.current = null;
    }
  }

  /**
   * Transactional rollback for failed fiber materialization.
   * Releases acquired resources in reverse acquisition order:
   * 1. disable scheduler hook
   * 2. dispose runtime bus registrations
   * 3. clear bound ref (identity-safe)
   * 4. run failed-startup cleanup
   * 5. destroy mounted children in reverse order
   * 6. unlink the partial fiber
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

    // 1. Disable scheduler hook
    if (journal.schedulerHookAttached === true && instance !== null) {
      try {
        this.clearUpdateHook(instance);
        this.dirtyFibers.delete(fiber);
      } catch (err: unknown) {
        cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // 2. Dispose runtime bus registrations
    if (journal.busWiringAttached === true) {
      try {
        this.disposeEffectableRuntimeBusWiring(fiber);
      } catch (err: unknown) {
        cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // 3. Clear bound ref (identity-safe)
    if (journal.refBound === true && fiber.vnode.ref !== undefined && journal.refOwner !== undefined) {
      try {
        this.clearRefSafe(fiber.vnode.ref, journal.refOwner);
      } catch (err: unknown) {
        cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // 4. Run failed-startup cleanup (if instance exists)
    let cleanupPromise: Promise<void> | null = null;
    if (instance !== null) {
      try {
        const cleanupRes = fiber.engine.runFailedCleanup(instance, true);
        if (isThenable(cleanupRes)) {
          cleanupPromise = cleanupRes;
        }
      } catch (err: unknown) {
        cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    // 5. Destroy mounted children in reverse order
    const destroyChildrenAndFinalize = (): void | Promise<void> => {
      const children = journal.mountedChildren;
      for (let i = children.length - 1; i >= 0; i -= 1) {
        try {
          const destroyRes = this.destroyFiber(children[i] as RuntimeFiber<unknown>);
          if (isThenable(destroyRes)) {
            return this.continueRollbackDestroyAsync(
              children,
              i,
              destroyRes,
              primaryError,
              cleanupErrors,
            );
          }
        } catch (err) {
          cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
        }
      }

      // 6. Finalize: attach cleanup errors to primary error
      this.finalizeRollback(primaryError, cleanupErrors);
    };

    if (cleanupPromise !== null) {
      return cleanupPromise.then(
        () => destroyChildrenAndFinalize(),
        (err) => {
          cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
          return destroyChildrenAndFinalize();
        },
      );
    }

    return destroyChildrenAndFinalize();
  }

  /**
   * Async continuation of rollback child destruction after one child's destroy returned a Promise.
   *
   * @param {RuntimeFiber<unknown>[]} children - mounted children
   * @param {number} lastIdx - index of the last processed child
   * @param {Promise<void>} pending - Promise from destroying the previous child
   * @param {Error} primaryError - original materialization error
   * @param {Error[]} cleanupErrors - accumulated cleanup errors
   * @returns {Promise<void>}
   */
  private async continueRollbackDestroyAsync (
    children: RuntimeFiber<unknown>[],
    lastIdx: number,
    pending: Promise<void>,
    primaryError: Error,
    cleanupErrors: Error[],
  ): Promise<void> {
    try {
      await pending;
    } catch (err) {
      cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
    }

    for (let i = lastIdx - 1; i >= 0; i -= 1) {
      try {
        const destroyRes = this.destroyFiber(children[i] as RuntimeFiber<unknown>);
        if (isThenable(destroyRes)) {
          await destroyRes;
        }
      } catch (err: unknown) {
        cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
    }

    this.finalizeRollback(primaryError, cleanupErrors);
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
   * Pre-mount buffer: `setState` during `onMount` cannot yet schedule reconcile
   * (the live hook is injected after startup). Marks the fiber; {@link injectUpdateHook}
   * after startup will call {@link scheduleUpdate}
   * (deferred until the mount pass completes).
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
   * Issue #10: skip scheduling when runtime is FAILED.
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
   * Issue #11: serialize all graph mutations.
   *
   * @param {() => Promise<void>} operation - operation to enqueue
   * @returns {Promise<void>}
   */
  private async enqueueOperation (operation: () => Promise<void>): Promise<void> {
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
   * Issue #11: single serialized owner of tree mutations.
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
          await operation();
        } catch {
          // Error is already propagated to the caller via the promise wrapper
          // Continue processing the queue (don't poison it forever)
        }
      }
    } finally {
      this.operationInProgress = false;
    }
  }

  /**
   * Queues one dirty-flush microtask and publishes {@link activeFlush} for await from `reconcile`.
   *
   * Issue #10: skip scheduling when runtime is FAILED.
   *
   * @returns {void}
   */
  private scheduleDirtyFlushMicrotask (): void {
    if (this.flushScheduled || this.state === RUNTIME_STATE.FAILED || this.state === RUNTIME_STATE.UNMOUNTING || this.state === RUNTIME_STATE.UNMOUNTED) {
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
   * Issue #11: respects state (UNMOUNTING/UNMOUNTED/FAILED) to cancel flush when unmount begins or failure occurs.
   * Issue #10: on unrecoverable error, invokes onAutoReconcileError then fail-stops.
   *
   * @returns {Promise<void>}
   */
  private async flushDirtyFibers (): Promise<void> {
    this.flushScheduled = false;

    if (this.state === RUNTIME_STATE.FAILED || this.state === RUNTIME_STATE.UNMOUNTING || this.state === RUNTIME_STATE.UNMOUNTED || this.flushing) {
      this.dirtyFibers.clear();
      return;
    }

    this.dirtyFlushPassCount += 1;
    this.flushing = true;
    const snapshot = Array.from(this.dirtyFibers);
    this.dirtyFibers.clear();

    try {
      for (const fiber of snapshot) {
        if (this.state === RUNTIME_STATE.FAILED || this.state === RUNTIME_STATE.UNMOUNTING || this.state === RUNTIME_STATE.UNMOUNTED) {
          break;
        }
        const res = this.reconcileDirtyFiber(fiber);
        if (isThenable(res)) {
          await res;
        }
      }
    } catch (error: unknown) {
      this.flushing = false;
      
      // Notify error handler before fail-stop (issue #10)
      if (this.onAutoReconcileError !== null) {
        this.onAutoReconcileError(error);
      }
      
      // Fail-stop on unrecoverable dirty-flush error (issue #10)
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
        
        // Notify error handler before fail-stop (issue #10)
        if (this.onAutoReconcileError !== null) {
          this.onAutoReconcileError(loopError);
        }
        
        // Fail-stop on loop limit (issue #10)
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
            fiber.children = nextChildren as Fiber[];
          },
          (error: unknown) => {
            const cleanupResult = this.runFiberFailedCleanup(fiber);
            if (isThenable(cleanupResult)) {
              return cleanupResult.then(() => {
                throw error;
              });
            }
            throw error;
          },
        );
      }

      fiber.children = childrenRes as Fiber[];
    } catch (error: unknown) {
      const cleanupResult = this.runFiberFailedCleanup(fiber);
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
      rt.state = RUNTIME_STATE.ACTIVE;
      return rt;
    } catch (error: unknown) {
      // Fail-stop on unrecoverable mount error (issue #10)
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
   * Issue #11: all reconcile calls are serialized through the operation queue.
   * Issue #10: rejects with terminal error when runtime is FAILED.
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

    // Reject immediately if runtime is in failed state (issue #10)
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

      if (this.state === RUNTIME_STATE.UNMOUNTING || this.state === RUNTIME_STATE.UNMOUNTED) {
        throw new Error('[Effectable] GraphRuntime: reconcile attempted after unmount started.');
      }

      if (this.state === RUNTIME_STATE.FAILED) {
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
        // Fail-stop on unrecoverable reconcile error (issue #10)
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
   * Issue #11: unmount is serialized, cached promise returned for concurrent callers.
   * Issue #10: safe and joinable even when runtime is FAILED.
   *
   * @returns {Promise<void>}
   */
  public async unmount (): Promise<void> {
    // If unmount already completed, return immediately
    if (this.state === RUNTIME_STATE.UNMOUNTED) {
      return;
    }

    // If unmount is in progress, return the cached promise (issue #11)
    if (this.cachedUnmountPromise !== null) {
      return this.cachedUnmountPromise;
    }

    // Transition to UNMOUNTING state (reject new reconcile calls)
    // If already FAILED, stay FAILED until unmount completes
    if (this.state !== RUNTIME_STATE.FAILED) {
      this.state = RUNTIME_STATE.UNMOUNTING;
    }

    // Create and cache the unmount promise
    this.cachedUnmountPromise = this.enqueueOperation(async () => {
      // Double-check unmounted state
      if (this.state === RUNTIME_STATE.UNMOUNTED) {
        return;
      }

      // Cancel any pending dirty flush
      this.dirtyFibers.clear();
      this.flushScheduled = false;

      // Wait for in-flight dirty flush to complete (issue #11)
      if (this.activeFlush !== null) {
        try {
          await this.activeFlush;
        } catch {
          // Ignore flush errors during unmount
        }
      }

      this.state = RUNTIME_STATE.UNMOUNTED;

      if (this.currentRoot !== null) {
        const d = this.destroyFiber(this.currentRoot);
        if (isThenable(d)) {
          await d;
        }
        this.currentRoot = null;
      }
    });

    return this.cachedUnmountPromise;
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
   * Issue #10: returns false when state is FAILED.
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
   * Current runtime state (issue #10).
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
   * @returns {RuntimeFiber<P> | Promise<RuntimeFiber<P>>}
   */
  private materialize<P>(
    vnode: VirtualServiceNode<P>,
    parentFiber: RuntimeFiber<unknown> | null,
    parentScope: ContextScope,
  ): RuntimeFiber<P> | Promise<RuntimeFiber<P>> {
    const engine = new LifecycleEngine();
    // Constructor is stored as ComponentConstructor<unknown> for covariance,
    // but invoked with concrete props P. The cast is safe: P extends unknown.
    const instance = new vnode.type(vnode.props) as Component<unknown, P>;

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

    // Recursively materialize children before running the parent's lifecycle
    const childVnodes = this.getChildVnodes(instance, vnode.children);

    // Validate unique keys BEFORE materialization (Option A: React v16.5 contract)
    // Prevent partial tree construction when duplicate keys are present
    this.validateUniqueKeys(
      childVnodes.map(vnode => ({ vnode, instance: null })),
      fiber as RuntimeFiber<unknown>,
      'current'
    );

    for (let i = 0; i < childVnodes.length; i++) {
      const childVnode = childVnodes[i] as VirtualServiceNode;
      let childRes: RuntimeFiber<unknown> | Promise<RuntimeFiber<unknown>>;
      
      try {
        childRes = this.materialize(childVnode, fiber as RuntimeFiber<unknown>, childScope);
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
        );
      }

      fiber.constructionJournal!.mountedChildren.push(childRes as RuntimeFiber<unknown>);
    }

    fiber.children = fiber.constructionJournal!.mountedChildren as Fiber[];

    // Bind ref to the instance
    if (vnode.ref !== undefined) {
      try {
        (vnode.ref as RefObject<typeof instance>).current = instance;
        fiber.constructionJournal!.refBound = true;
        fiber.constructionJournal!.refOwner = instance;
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

    // Run lifecycle after all children are materialized.
    // Pre-mount hook buffers setState from onMount until injectUpdateHook.
    this.injectPreMountUpdateHook(instance, fiber);
    const startupRes = engine.runStartup(instance);

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
   * Async continuation of {@link materialize} after a child returned a Promise.
   * Finishes remaining child fibers with `await`, then runs parent startup.
   *
   * @param {RuntimeFiber<P>} fiber - current fiber
   * @param {Component<unknown, P>} instance - component instance
   * @param {LifecycleEngine} engine - lifecycle engine
   * @param {VirtualServiceNode<P>} vnode - virtual node
   * @param {VirtualServiceNode[]} childVnodes - all child vnodes
   * @param {ContextScope} childScope - scope for child nodes
   * @param {Promise<RuntimeFiber<unknown>>} pending - Promise for the current child
   * @param {number} pendingIdx - index of the current child
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
        const childRes = this.materialize(childVnode, fiber as RuntimeFiber<unknown>, childScope);
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

    if (vnode.ref !== undefined) {
      try {
        (vnode.ref as RefObject<typeof instance>).current = instance;
        journal.refBound = true;
        journal.refOwner = instance;
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        const rollbackRes = this.rollbackFailedMaterialization(fiber, error);
        if (isThenable(rollbackRes)) {
          await rollbackRes;
        }
        throw error;
      }
    }

    try {
      this.attachEffectableRuntimeBusWiring(instance, fiber);
      if (fiber.effectableRuntimeBusDisposer !== undefined) {
        journal.busWiringAttached = true;
      }
    } catch (err) {
      const rollbackRes = this.rollbackFailedMaterialization(
        fiber,
        err instanceof Error ? err : new Error(String(err)),
      );
      if (isThenable(rollbackRes)) {
        await rollbackRes;
      }
      throw err;
    }

    this.injectPreMountUpdateHook(instance, fiber);
    const startupRes = engine.runStartup(instance);
    const resolved = isThenable(startupRes) ? await startupRes : startupRes;

    if (!resolved.ok) {
      const error = resolved.error instanceof Error ? resolved.error : new Error(String(resolved.error));
      const rollbackRes = this.rollbackFailedMaterialization(fiber, error);
      if (isThenable(rollbackRes)) {
        await rollbackRes;
      }
      throw error;
    }

    fiber.lifecycleStatus = engine.getStatus();
    fiber.effectTag = null;
    journal.schedulerHookAttached = true;
    this.injectUpdateHook(instance, fiber);
    return fiber;
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
   * @returns {Promise<RuntimeFiber<P>>}
   */
  private reconcileFiber<P>(
    current: RuntimeFiber<P>,
    nextVnode: VirtualServiceNode<P>,
    parentFiber: RuntimeFiber<unknown> | null,
    parentScope: ContextScope,
  ): RuntimeFiber<P> | Promise<RuntimeFiber<P>> {
    const sameType = current.vnode.type === nextVnode.type;
    const sameKey = (current.vnode.key ?? null) === (nextVnode.key ?? null);

    if (sameType && sameKey) {
      return this.updateFiber(current, nextVnode, parentFiber, parentScope);
    }

    // Type or key changed — destroy the old node, create a new one.
    // Sync fast-path if both destroy and materialize completed synchronously.
    const destroyRes = this.destroyFiber(current as RuntimeFiber<unknown>);
    if (isThenable(destroyRes)) {
      return destroyRes.then(() => this.materialize(nextVnode, parentFiber, parentScope));
    }
    return this.materialize(nextVnode, parentFiber, parentScope);
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

    // Re-inject context fields when parent scope changed (issue #15)
    let contextChanged = false;
    if (current.scope !== parentScope) {
      try {
        contextChanged = injectContextFields(instance, parentScope);
      } catch (error: unknown) {
        const cleanupResult = this.runFiberFailedCleanup(current as RuntimeFiber<unknown>);
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

    // Call onUpdate if props or context changed (React 16.5 class-component style: one hook)
    const propsChanged = prevProps !== instance.props;
    if ((propsChanged || contextChanged) && current.engine.canUpdate()) {
      try {
        instance.onUpdate(prevProps, instance.props);
      } catch (error: unknown) {
        const cleanupResult = this.runFiberFailedCleanup(current as RuntimeFiber<unknown>);
        if (isThenable(cleanupResult)) {
          return cleanupResult.then(() => {
            throw error;
          });
        }
        throw error;
      }
    }

    // Update ref
    if (nextVnode.ref !== undefined) {
      (nextVnode.ref as RefObject<typeof instance>).current = instance;
    }

    // Reconcile child nodes (sync fast-path if all children are sync).
    let nextChildVnodes: VirtualServiceNode[];
    try {
      nextChildVnodes = this.getChildVnodes(instance, nextVnode.children);
    } catch (error: unknown) {
      const cleanupResult = this.runFiberFailedCleanup(current as RuntimeFiber<unknown>);
      if (isThenable(cleanupResult)) {
        return cleanupResult.then(() => {
          throw error;
        });
      }
      throw error;
    }

    const childrenRes = this.reconcileChildren(
      current.children as RuntimeFiber<unknown>[],
      nextChildVnodes,
      current as RuntimeFiber<unknown>,
      childScope,
    );

    if (isThenable(childrenRes)) {
      return childrenRes.then((nextChildren) => {
        this.applyFiberUpdate(current, nextVnode, parentFiber, parentScope, nextChildren);
        return current;
      });
    }

    this.applyFiberUpdate(current, nextVnode, parentFiber, parentScope, childrenRes);
    return current;
  }

  /**
   * Fiber cleanup after update/compose error: `runFailedCleanup` + bus dispose.
   * Does not leave the node in `ready`.
   *
   * @param {RuntimeFiber<unknown>} fiber - fiber that failed
   * @returns {void | Promise<void>}
   */
  private runFiberFailedCleanup (fiber: RuntimeFiber<unknown>): void | Promise<void> {
    const instance = fiber.instance;
    if (instance === null) {
      return;
    }

    this.clearUpdateHook(instance);
    this.dirtyFibers.delete(fiber);

    const cleanupResult = fiber.engine.runFailedCleanup(instance, true);
    if (isThenable(cleanupResult)) {
      return cleanupResult.then(() => {
        this.disposeEffectableRuntimeBusWiring(fiber);
        fiber.lifecycleStatus = fiber.engine.getStatus();
      });
    }

    this.disposeEffectableRuntimeBusWiring(fiber);
    fiber.lifecycleStatus = fiber.engine.getStatus();
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
  private applyFiberUpdate<P> (
    current: RuntimeFiber<P>,
    nextVnode: VirtualServiceNode<P>,
    parentFiber: RuntimeFiber<unknown> | null,
    parentScope: ContextScope,
    nextChildren: RuntimeFiber<unknown>[],
  ): void {
    current.vnode = nextVnode;
    current.parentFiber = parentFiber as RuntimeFiber<unknown> | null;
    current.children = nextChildren as Fiber[];
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
        );

        if (isThenable(reconciled)) {
          return this.continueStableReconcileAsync(
            stableResult, reconciled, i, nextVnodes, currentChildren, parentFiber, childScope,
          );
        }

        stableResult.push(reconciled);
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
      );
      resultSoFar.push(isThenable(reconciled) ? await reconciled : (reconciled as RuntimeFiber<unknown>));
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

            const reconciledRes = this.reconcileFiber(
              currentFiber,
              nextVnode as VirtualServiceNode<unknown>,
              parentFiber,
              childScope,
            );
            nextChildren.push(isThenable(reconciledRes) ? await reconciledRes : reconciledRes);
          } else if (nextKey === undefined && unkeyedIdx < unkeyedCurrent.length) {
            const currentFiber = unkeyedCurrent[unkeyedIdx];
            unkeyedIdx += 1;

            const reconciledRes = this.reconcileFiber(
              currentFiber as RuntimeFiber<unknown>,
              nextVnode as VirtualServiceNode<unknown>,
              parentFiber,
              childScope,
            );
            nextChildren.push(isThenable(reconciledRes) ? await reconciledRes : reconciledRes);
          } else {
            // New node — PLACE
            const newRes = this.materialize(nextVnode, parentFiber, childScope);
            nextChildren.push(isThenable(newRes) ? await newRes : newRes);
          }
        }

        // Destroy remaining unpaired current children (keyed)
        for (const [, orphan] of keyedCurrentMap) {
          const d = this.destroyFiber(orphan);
          if (isThenable(d)) {
            await d;
          }
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

          const reconciledRes = this.reconcileFiber(
            currentFiber as RuntimeFiber<unknown>,
            nextVnode as VirtualServiceNode<unknown>,
            parentFiber,
            childScope,
          );
          nextChildren.push(isThenable(reconciledRes) ? await reconciledRes : reconciledRes);
        } else {
          // New node — PLACE
          const newRes = this.materialize(nextVnode, parentFiber, childScope);
          nextChildren.push(isThenable(newRes) ? await newRes : newRes);
        }
      }
    }

    // Destroy remaining unpaired unkeyed children
    for (let i = unkeyedIdx; i < unkeyedCurrent.length; i += 1) {
      const orphan = unkeyedCurrent[i];

      if (orphan !== undefined) {
        const d = this.destroyFiber(orphan);
        if (isThenable(d)) {
          await d;
        }
      }
    }

    return nextChildren;
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
   * @param {RuntimeFiber} fiber - fiber to destroy
   * @returns {void | Promise<void>}
   */
  private destroyFiber (fiber: RuntimeFiber<unknown>, collectErrors: Error[] | null = null): void | Promise<void> {
    const children = fiber.children;
    const n = children.length;

    // Sync recursion over children until the first async
    for (let i = 0; i < n; i++) {
      const childRes = this.destroyFiber(children[i] as RuntimeFiber<unknown>, collectErrors);
      if (isThenable(childRes)) {
        return this.continueDestroyAsync(fiber, children, i, childRes, collectErrors);
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

    // Check for shutdown errors (issue #12: cleanup errors must be visible during fail-stop)
    if (!shutdownRes.ok) {
      if (collectErrors !== null) {
        // Fail-stop mode: collect cleanup errors, don't throw
        collectErrors.push(shutdownRes.error instanceof Error ? shutdownRes.error : new Error(String(shutdownRes.error)));
      }
      // Still finalize the fiber even if shutdown failed
      this.disposeEffectableRuntimeBusWiring(fiber);
      const ref = fiber.vnode.ref;
      if (ref !== undefined) {
        ref.current = null;
      }
      fiber.lifecycleStatus = fiber.engine.getStatus();
      return;
    }

    this.disposeEffectableRuntimeBusWiring(fiber);

    // Clear ref after unmount
    const ref = fiber.vnode.ref;
    if (ref !== undefined) {
      ref.current = null;
    }
    fiber.lifecycleStatus = fiber.engine.getStatus();
  }

  /**
   * Async continuation of {@link destroyFiber} after one of the children returned a Promise.
   *
   * @param {RuntimeFiber<unknown>} fiber - current fiber
   * @param {Fiber[]} children - children list
   * @param {number} pendingIdx - index of the pending child
   * @param {PromiseLike<void>} pending - Promise from destroying the child
   * @returns {Promise<void>}
   */
  private async continueDestroyAsync (
    fiber: RuntimeFiber<unknown>,
    children: Fiber[],
    pendingIdx: number,
    pending: PromiseLike<void>,
    collectErrors: Error[] | null = null,
  ): Promise<void> {
    await pending;

    for (let i = pendingIdx + 1; i < children.length; i++) {
      const r = this.destroyFiber(children[i] as RuntimeFiber<unknown>, collectErrors);
      if (isThenable(r)) {
        await r;
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

    this.disposeEffectableRuntimeBusWiring(fiber);

    const ref = fiber.vnode.ref;
    if (ref !== undefined) {
      ref.current = null;
    }
    fiber.lifecycleStatus = fiber.engine.getStatus();
  }

  /**
   * Async finalization of {@link destroyFiber} when children were destroyed synchronously
   * but `runShutdown` returned a Promise.
   *
   * @param {RuntimeFiber<unknown>} fiber
   * @param {PromiseLike<unknown>} pendingShutdown
   * @returns {Promise<void>}
   */
  private async finalizeDestroyAsync (
    fiber: RuntimeFiber<unknown>,
    pendingShutdown: PromiseLike<unknown>,
    collectErrors: Error[] | null = null,
  ): Promise<void> {
    const shutdownRes = await pendingShutdown;

    // Check for shutdown errors (issue #12: cleanup errors must be visible during fail-stop)
    if (typeof shutdownRes === 'object' && shutdownRes !== null && 'ok' in shutdownRes && !shutdownRes.ok) {
      if (collectErrors !== null) {
        // Fail-stop mode: collect cleanup errors, don't throw
        const err = (shutdownRes as { ok: false; error: unknown }).error;
        collectErrors.push(err instanceof Error ? err : new Error(String(err)));
      }
      // Still finalize the fiber even if shutdown failed
      this.disposeEffectableRuntimeBusWiring(fiber);
      const ref = fiber.vnode.ref;
      if (ref !== undefined) {
        ref.current = null;
      }
      fiber.lifecycleStatus = fiber.engine.getStatus();
      return;
    }

    this.disposeEffectableRuntimeBusWiring(fiber);

    const ref = fiber.vnode.ref;
    if (ref !== undefined) {
      ref.current = null;
    }
    fiber.lifecycleStatus = fiber.engine.getStatus();
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
