/**
 * Node lifecycle engine (`LifecycleEngine`) and transition result type.
 *
 * The state machine defines stage order: `registered` → `resolved` → `created` →
 * `mounted` → `ready` → `unmounting` → `unmounted` → `destroyed`.
 * Any stage may transition to `failed`; there is no reverse transition from `failed`
 * (except forced `destroy` via teardown scenarios).
 *
 * Public component hooks are called in the expected order:
 * - startup: `onMount`
 * - in stage `ready`: `onUpdate` (as decided by GraphRuntime)
 * - shutdown / cleanup: `onUnmount`
 *
 * @module Effectable/component/lifecycle
 */

import type { Component } from './Component';
import type { NodeLifecycleStatus } from './types';

/**
 * Result of an asynchronous lifecycle transition attempt (startup / shutdown).
 *
 * Errors from hooks are not rethrown: on failure the branch
 * `{ ok: false, error }` is returned; success is `{ ok: true }`.
 */
export type LifecycleTransitionResult =
  | { ok: true }
  | { ok: false; error: unknown };

/**
 * Target stage name for {@link LifecycleEngine.canTransitionTo}: only “forward” along the graph,
 * without returning to already passed stages (except special rules for `failed`).
 */
type ForwardStage =
  | 'resolved'
  | 'created'
  | 'mounted'
  | 'ready'
  | 'unmounting'
  | 'unmounted'
  | 'destroyed'
  | 'failed';

/**
 * Numeric lifecycle stage codes for O(1) comparisons.
 *
 * Used instead of repeated lookups by string stage-order keys.
 * Object constant instead of `const enum` — compatibility with `isolatedModules`.
 *
 * Keys: Registered … Failed; values — monotonically increasing numbers for stage comparison.
 */
const STAGE = {
  Registered: 0,
  Resolved: 1,
  Created: 2,
  Mounted: 3,
  Ready: 4,
  Unmounting: 5,
  Unmounted: 6,
  Destroyed: 7,
  Failed: 8,
} as const;

/** Internal stage representation: a number from {@link STAGE}. */
type LifecycleStage = typeof STAGE[keyof typeof STAGE];

/**
 * Array index = numeric stage code; value = string `NodeLifecycleStatus`.
 * Used by {@link LifecycleEngine.getStatus}.
 */
const STAGE_TO_STATUS: readonly NodeLifecycleStatus[] = [
  'registered',  // 0
  'resolved',    // 1
  'created',     // 2
  'mounted',     // 3
  'ready',       // 4
  'unmounting',  // 5
  'unmounted',   // 6
  'destroyed',   // 7
  'failed',      // 8
];

/**
 * Mapping from string target stage (`ForwardStage`) to numeric code for comparison
 * with `currentStage` in {@link LifecycleEngine.canTransitionTo}.
 */
const STAGE_FROM_FORWARD: Record<ForwardStage, LifecycleStage> = {
  resolved: STAGE.Resolved,
  created: STAGE.Created,
  mounted: STAGE.Mounted,
  ready: STAGE.Ready,
  unmounting: STAGE.Unmounting,
  unmounted: STAGE.Unmounted,
  destroyed: STAGE.Destroyed,
  failed: STAGE.Failed,
};

/**
 * Bits indicating presence of the corresponding hook methods on the component instance.
 *
 * Filled in {@link LifecycleEngine.initHookFlags}; when `hookFlags === 0`
 * startup/shutdown can finish without `typeof` checks on each hook.
 */
const HookBit = {
  Mount: 1 << 0,
  Update: 1 << 1,
  Unmount: 1 << 2,
} as const;

/**
 * Checks whether a value is thenable (Promise-like).
 * Used for the sync fast-path of hooks (3.55x speedup):
 * if the hook returned a non-Promise — skip await and the related microtask hop.
 *
 * @param {unknown} value - hook return value
 * @returns {boolean} true if the value is Promise-like
 */
function isThenable (value: unknown): value is PromiseLike<unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * Lifecycle state machine for one node in GraphRuntime: one instance
 * per node (fiber).
 *
 * Invariants:
 * - stages mostly advance monotonically; update passes are allowed in `ready`;
 * - after `failed`, further transitions are limited (see {@link canTransitionTo});
 * - {@link Component.onUnmount} is called at most once per instance.
 *
 * @example
 * const engine = new LifecycleEngine();
 * engine.initHookFlags(component);
 * await engine.runStartup(component);
 */
export class LifecycleEngine {
  /**
   * Current stage as a number (see {@link STAGE}): comparisons without string lookups.
   */
  private currentStage: LifecycleStage = STAGE.Registered;
  private unmountCalled = false;

  /**
   * Bit flags for which hooks the component has.
   * 0 — hooks not initialized or absent (fast-exit in runStartup/runShutdown).
   * Set via initHookFlags() after instance creation.
   */
  private hookFlags = 0;

  /**
   * Whether hookFlags were initialized via initHookFlags().
   * Without this, the fast-exit on hookFlags === 0 would apply before initialization.
   */
  private hookFlagsInitialized = false;

  /**
   * Returns the string node status for the external API (GraphRuntime, debugging, UI).
   *
   * @returns {NodeLifecycleStatus} current stage as `NodeLifecycleStatus`
   */
  public getStatus (): NodeLifecycleStatus {
    return STAGE_TO_STATUS[this.currentStage] as NodeLifecycleStatus;
  }

  /**
   * Computes and stores a bit mask of hook methods present on the instance.
   * Must be called exactly once after instance creation (e.g. from materialize).
   * Lets {@link runStartup} and {@link runShutdown} skip per-hook checks
   * when none are declared.
   *
   * @param {Component<unknown, unknown>} instance - component instance with optional hooks
   * @returns {void}
   */
  public initHookFlags (instance: Component<unknown, unknown>): void {
    this.hookFlags =
      (typeof instance.onMount   === 'function' ? HookBit.Mount   : 0) |
      (typeof instance.onUpdate  === 'function' ? HookBit.Update  : 0) |
      (typeof instance.onUnmount === 'function' ? HookBit.Unmount : 0);

    this.hookFlagsInitialized = true;
  }

  /**
   * Startup phase: if present — call `onMount`, advance stages to `ready`.
   * On exception: stage already `Mounted` → by default {@link runFailedCleanup}(`wasMounted=true`)
   * (attempt `onUnmount` + teardown), result `{ ok: false, error }`.
   *
   * When `options.deferFailedCleanup` is true (GraphRuntime materialization), onMount failure
   * marks the stage `failed` and returns `{ ok: false }` **without** calling `onUnmount`.
   * The caller must destroy mounted children first, then invoke {@link runFailedCleanup}, so
   * teardown order stays children → parent.
   *
   * Returns a synchronous {@link LifecycleTransitionResult} if `onMount` returned
   * a non-thenable value (sync fast-path); otherwise a Promise.
   * `await` works correctly with either union branch.
   *
   * @param {Component<unknown, unknown>} instance - component instance
   * @param {{ deferFailedCleanup?: boolean }} [options] - startup options
   * @returns {LifecycleTransitionResult | Promise<LifecycleTransitionResult>}
   */
  public runStartup (
    instance: Component<unknown, unknown>,
    options?: { deferFailedCleanup?: boolean },
  ): LifecycleTransitionResult | Promise<LifecycleTransitionResult> {
    const deferFailedCleanup = options?.deferFailedCleanup === true;

    this.currentStage = STAGE.Resolved;
    this.currentStage = STAGE.Created;

    // Fast-exit for pure components without startup hooks (1.15x)
    if (this.hookFlagsInitialized && this.hookFlags === 0) {
      this.currentStage = STAGE.Mounted;
      this.currentStage = STAGE.Ready;
      return { ok: true };
    }

    try {
      this.currentStage = STAGE.Mounted;

      if (typeof instance.onMount === 'function') {
        const r = instance.onMount();
        if (isThenable(r)) {
          return this.continueStartupAsync(instance, r, deferFailedCleanup);
        }
      }

      this.currentStage = STAGE.Ready;
      return { ok: true };
    } catch (error) {
      if (deferFailedCleanup) {
        // Leave stage `failed` so GraphRuntime can unmount children before onUnmount.
        this.currentStage = STAGE.Failed;
        return { ok: false, error };
      }

      // Stage is already Mounted before onMount — cleanup must attempt onUnmount.
      const cleanupResult = this.runFailedCleanup(instance, true);
      if (isThenable(cleanupResult)) {
        return cleanupResult.then(() => ({ ok: false, error }));
      }
      return { ok: false, error };
    }
  }

  /**
   * Async continuation of {@link runStartup} after `onMount` returned a Promise.
   *
   * @param {Component<unknown, unknown>} instance - component instance
   * @param {PromiseLike<unknown>} pending - Promise from onMount
   * @param {boolean} deferFailedCleanup - when true, skip onUnmount (caller orders teardown)
   * @returns {Promise<LifecycleTransitionResult>}
   */
  private async continueStartupAsync (
    instance: Component<unknown, unknown>,
    pending: PromiseLike<unknown>,
    deferFailedCleanup: boolean,
  ): Promise<LifecycleTransitionResult> {
    try {
      await pending;
      this.currentStage = STAGE.Ready;
      return { ok: true };
    } catch (error) {
      if (deferFailedCleanup) {
        this.currentStage = STAGE.Failed;
        return { ok: false, error };
      }

      const cleanupResult = this.runFailedCleanup(instance, true);
      if (isThenable(cleanupResult)) {
        await cleanupResult;
      }
      return { ok: false, error };
    }
  }

  /**
   * Shutdown phase: if needed `onUnmount`, stages `unmounting` → `unmounted` → `destroyed`.
   * If the node is already `destroyed`, noop. An error in `onUnmount` is returned as `{ ok: false, error }`.
   *
   * Returns a synchronous {@link LifecycleTransitionResult} if `onUnmount` returned non-thenable
   * (sync fast-path); otherwise a Promise. `await` works correctly
   * with either union branch.
   *
   * @param {Component<unknown, unknown>} instance - component instance
   * @returns {LifecycleTransitionResult | Promise<LifecycleTransitionResult>}
   */
  public runShutdown (
    instance: Component<unknown, unknown>,
  ): LifecycleTransitionResult | Promise<LifecycleTransitionResult> {
    if (this.currentStage === STAGE.Destroyed) {
      return { ok: true };
    }

    // Numeric comparisons instead of 4 STAGE_ORDER string lookups (1.10x)
    const wasReady =
      this.currentStage >= STAGE.Mounted &&
      this.currentStage <= STAGE.Ready;

    this.currentStage = STAGE.Unmounting;

    let unmountError: unknown = null;

    if (wasReady && !this.unmountCalled && typeof instance.onUnmount === 'function') {
      this.unmountCalled = true;
      try {
        const r = instance.onUnmount();
        if (isThenable(r)) {
          return this.continueShutdownAsync(r);
        }
      } catch (error) {
        unmountError = error;
      }
    }

    this.currentStage = STAGE.Unmounted;
    this.currentStage = STAGE.Destroyed;

    if (unmountError !== null) {
      return { ok: false, error: unmountError };
    }
    return { ok: true };
  }

  /**
   * Async continuation of {@link runShutdown} after `onUnmount` returned a Promise.
   *
   * @param {PromiseLike<unknown>} pendingUnmount - Promise from onUnmount
   * @returns {Promise<LifecycleTransitionResult>}
   */
  private async continueShutdownAsync (
    pendingUnmount: PromiseLike<unknown>,
  ): Promise<LifecycleTransitionResult> {
    let unmountError: unknown = null;
    try {
      await pendingUnmount;
    } catch (error) {
      unmountError = error;
    }

    this.currentStage = STAGE.Unmounted;
    this.currentStage = STAGE.Destroyed;

    if (unmountError !== null) {
      return { ok: false, error: unmountError };
    }
    return { ok: true };
  }

  /**
   * Forced cleanup after failure: stage `failed`, if `wasMounted` — attempt
   * `onUnmount` (errors swallowed), then final teardown.
   * Used on `onMount` fail (stage already `Mounted`) and by GraphRuntime on errors
   * outside startup (e.g. during update).
   *
   * Returns `void` synchronously if `onUnmount` is absent or returned non-thenable;
   * otherwise a Promise.
   *
   * @param {Component<unknown, unknown>} instance - component instance
   * @param {boolean} wasMounted - `true` if the node had already mounted before the error
   * @returns {void | Promise<void>}
   */
  public runFailedCleanup (
    instance: Component<unknown, unknown>,
    wasMounted: boolean,
  ): void | Promise<void> {
    this.currentStage = STAGE.Failed;

    if (wasMounted && !this.unmountCalled && typeof instance.onUnmount === 'function') {
      this.unmountCalled = true;
      try {
        const r = instance.onUnmount();
        if (isThenable(r)) {
          return this.continueFailedCleanupAsync(r);
        }
      } catch {
        // Continue teardown even if onUnmount fails
      }
    }

    return this.runForcedDestroy();
  }

  /**
   * Async continuation of {@link runFailedCleanup} after async unmount.
   *
   * @param {PromiseLike<unknown>} pendingUnmount - Promise from onUnmount
   * @returns {Promise<void>}
   */
  private async continueFailedCleanupAsync (
    pendingUnmount: PromiseLike<unknown>,
  ): Promise<void> {
    try {
      await pendingUnmount;
    } catch {
      // Continue teardown even if onUnmount fails
    }

    const destroyResult = this.runForcedDestroy();
    if (isThenable(destroyResult)) {
      await destroyResult;
    }
  }

  /**
   * Idempotent teardown: marks the node as `destroyed`. No `onDestroy` call
   * (legacy hook removed); side-effect cleanup happens in `onUnmount`.
   *
   * @returns {void | Promise<void>} always `void` (signature kept for compatibility)
   */
  private runForcedDestroy (): void | Promise<void> {
    this.currentStage = STAGE.Destroyed;
  }

  /**
   * Whether the node can accept an update pass (`onUpdate`): only stage `ready`.
   *
   * @returns {boolean} `true` if an update-pass may be called
   */
  public canUpdate (): boolean {
    return this.currentStage === STAGE.Ready;
  }

  /**
   * Whether the node is in a terminal stage: `destroyed` or `failed` (further work with the node is not expected).
   *
   * @returns {boolean} `true` for `destroyed` and `failed`
   */
  public isTerminated (): boolean {
    return (
      this.currentStage === STAGE.Destroyed || this.currentStage === STAGE.Failed
    );
  }

  /**
   * Moves the node to `failed` without calling hooks (external error, marking in GraphRuntime).
   * If the node is already terminal, state is unchanged.
   *
   * @returns {void}
   */
  public markFailed (): void {
    if (!this.isTerminated()) {
      this.currentStage = STAGE.Failed;
    }
  }

  /**
   * Whether a “forward” transition to `target` is allowed relative to the current numeric stage.
   * From `failed` only a transition to `destroyed` is allowed (aligned with forced teardown).
   *
   * @param {ForwardStage} target - target stage under test by string name
   * @returns {boolean} `true` if the target stage is strictly “later” than current (or special case `failed`→`destroyed`)
   */
  public canTransitionTo (target: ForwardStage): boolean {
    if (this.currentStage === STAGE.Failed) {
      return target === 'destroyed';
    }

    // Numeric comparison instead of two STAGE_ORDER string lookups (1.11x)
    return STAGE_FROM_FORWARD[target] > this.currentStage;
  }
}
