/**
 * Base class with state and lifecycle for Effectable: GraphRuntime,
 * connect-HOC (class-based), and standalone use.
 *
 * Holds `state`, updates it via {@link Component.setState}, and after each update calls
 * {@link Component.onUpdate}.
 *
 * **Single writer:** only {@link Component.setState} may change state after construction
 * (triggers `onUpdate` and reconcile schedule). Direct `this.state = …` after init emits
 * `console.warn` and does **not** change `#state`. Constructor init (`super(props, initial)`
 * or `this.state = …` in the constructor body) is allowed without warning. If reconciliation
 * is not needed, use a ref.
 *
 * **Modes:**
 * - **Standalone** — `Component` as a lightweight stateful object without GraphRuntime: `setState`
 *   immediately leads to `onUpdate`, with no “only after mount” restriction.
 * - **Mounted (GraphRuntime)** — LifecycleEngine defines hook order; `onUpdate` runs only after
 *   a successful {@link Component.onMount}.
 *
 * **Who calls hooks:** `onMount`, `onUnmount`, {@link Component.compose} — GraphRuntime in mounted mode.
 * `connect`-HOC overrides `onMount`/`onUnmount` to manage the store subscription and delegates to
 * `super.onMount?.()` / `super.onUnmount?.()` on the subclass.
 *
 * @module Effectable/component/Component
 */

import type { Lifecycle } from './types';
import type { VirtualServiceNode } from './types';
import { SCHEDULE_UPDATE_HOOK } from './types';

/**
 * Argument to {@link Component.setState}: a partial state (shallow-merged with previous `state`) or
 * a function `(prevState, props) => Partial<S>`.
 *
 * @template S Instance state type.
 * @template P Instance props type.
 */
export type SetStateUpdate<S, P = unknown> =
  | Partial<S>
  | ((prevState: S, props: P) => Partial<S>);

/** Warn text for forbidden direct `this.state =` after construction. */
const DIRECT_STATE_ASSIGNMENT_WARN =
  '[Effectable] Component: direct assignment to `state` is not supported. ' +
  'Use `setState(...)` so `onUpdate` and reconcile run. ' +
  'If you do not need reconciliation, store the value in a ref (`@UseRef`) instead of state.';

/**
 * Abstract base class with state and lifecycle.
 * Implements the {@link Lifecycle} contract: `onMount` → `onUpdate*` → `onUnmount`.
 * GraphRuntime additionally uses {@link Component.compose} for a declarative subtree.
 *
 * @template S Type of {@link Component.state}.
 * @template P Type of {@link Component.props}.
 * @implements {Lifecycle}
 *
 * @example
 * ```ts
 * class Tick extends Component<{ count: number }, { step: number }> {
 *   constructor (props: { step: number }) {
 *     super(props);
 *     this.state = { count: 0 };
 *   }
 *   bump () {
 *     this.setState((s, p) => ({ count: s.count + p.step }));
 *   }
 * }
 * ```
 */
export abstract class Component<S = unknown, P = unknown>
implements Lifecycle {
  /**
   * Opt-in flag for HFT components: if `true`, {@link Component.setState} applies
   * updates **in-place** on the current `this.state` instead of creating a new object via spread.
   *
   * Yields 8.6x–710x speedup depending on state size,
   * but breaks immutability semantics: `prev` and `next` in `onUpdate` point to the same object.
   * Enable only for components whose `onUpdate` does not rely on prev/next separation.
   *
   * Subclass activates the flag like this:
   * ```ts
   * class FastTicker extends Component<State, Props> {
   *   public static override readonly mutableState = true;
   * }
   * ```
   */
  public static readonly mutableState: boolean = false;

  /** Backing store for {@link Component.state}. Written by init, the setter, or {@link Component.setState}. */
  #state: S;

  /**
   * When `true`, direct `this.state =` does not warn (constructor init window).
   * Closed after the full `new` constructor chain finishes (microtask).
   */
  #allowDirectStateWrite: boolean;

  /**
   * When `true`, the setter is being used by {@link Component.setState} and must not warn.
   * Assignment still goes through `this.state =` so a subclass class-field `state = …`
   * (own data property that shadows the accessor) stays in sync with setState.
   */
  #setStateWriting: boolean;

  /** Instance inputs: filled by GraphRuntime, connect-HOC, or calling code. */
  public props: P;

  /**
   * Current instance state after the last commit in {@link Component.setState}
   * (or constructor init). Read freely; do not assign after construction — use `setState`.
   */
  public get state (): S {
    return this.#state;
  }

  /**
   * Direct assignment after construction is forbidden: emits {@link console.warn} and leaves
   * `#state` unchanged (no write, no `onUpdate`, no reconcile). Prefer {@link Component.setState}.
   * Allowed without warning during construction (`super(props, initial)` or subclass ctor body)
   * and while {@link Component.setState} commits via `#setStateWriting`.
   */
  public set state (value: S) {
    if (!this.#allowDirectStateWrite && !this.#setStateWriting) {
      console.warn(DIRECT_STATE_ASSIGNMENT_WARN);
      return;
    }
    this.#state = value;
  }

  /**
   * @param {P} props Props available in the {@link Component.setState} callback and in the subclass.
   * @param {S} [initialState] Initial state; if omitted, an empty object is used as `S`.
   */
  constructor (props: P, initialState?: S) {
    this.props = props;
    this.#allowDirectStateWrite = true;
    this.#setStateWriting = false;
    this.#state = (initialState ?? {}) as S;
    // Subclass constructor bodies run synchronously after `super()` and may assign `this.state`.
    // Close the gate once the full `new` constructor chain has finished.
    queueMicrotask(() => {
      this.#allowDirectStateWrite = false;
    });
  }

  /**
   * Computes the next state as a shallow merge of `prev` with the update object or with the
   * function result, then calls {@link Component.onUpdate}.
   *
   * If the class sets `static mutableState = true`, applies updates in-place
   * on `this.state` — zero allocations, but `prev === next`.
   *
   * @param {SetStateUpdate<S, P>} update Partial state or `(prevState, props) => Partial<S>`.
   * @returns {void}
   */
  public setState (update: SetStateUpdate<S, P>): void {
    // Read/write via `this.state` (not `#state`) so a subclass class-field `state = …`
    // that shadows the accessor still receives setState commits.
    const prev = this.state;
    const delta = typeof update === 'function'
      ? (update as (prev: S, props: P) => Partial<S>)(prev, this.props)
      : update;

    // HFT fast-path: in-place state mutation without allocating a new object
    // (8.6x–710x speedup). Enabled via static mutableState = true.
    if ((this.constructor as { mutableState?: boolean }).mutableState === true) {
      const target = prev as unknown as Record<string, unknown>;
      const src = delta as unknown as Record<string, unknown>;
      // Own keys only (matches `{ ...prev, ...delta }`). Use defineProperty —
      // `target[k] =` invokes the Object.prototype `__proto__` setter when
      // `k === '__proto__'` (e.g. JSON.parse payloads), replacing state's
      // [[Prototype]] and leaking inherited phantom fields.
      for (const k of Object.keys(src)) {
        Object.defineProperty(target, k, {
          value: src[k],
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      // State is already committed: always schedule even if onUpdate throws,
      // otherwise mounted compose/children stay stale after a successful write.
      try {
        this.onUpdate(prev, prev);
      } finally {
        (this as unknown as { [SCHEDULE_UPDATE_HOOK]?: () => void })[SCHEDULE_UPDATE_HOOK]?.();
      }
      return;
    }

    // Shallow-copy previous state and delta to avoid mutating the original state
    const next = { ...prev, ...delta };
    this.#setStateWriting = true;
    try {
      this.state = next as S;
    } finally {
      this.#setStateWriting = false;
    }
    // State is already committed: always schedule even if onUpdate throws,
    // otherwise mounted compose/children stay stale after a successful write.
    try {
      this.onUpdate(prev, next);
    } finally {
      (this as unknown as { [SCHEDULE_UPDATE_HOOK]?: () => void })[SCHEDULE_UPDATE_HOOK]?.();
    }
  }

  /**
   * Called on every `state` change (from {@link Component.setState} or from connect-HOC
   * via `setState({})` after merging mapped props).
   * In standalone — immediately after `setState`. In mounted mode — only after a successful
   * {@link Component.onMount} (decided by GraphRuntime). Override in subclasses.
   *
   * @param {S} _prev State before the update was applied.
   * @param {S} _next State after the update was applied.
   * @returns {void}
   */
  public onUpdate (_prev: S, _next: S): void {
    // Empty by default; subclass overrides as needed.
  }

  /**
   * Optional: node mount in GraphRuntime. Typically used to start subscriptions,
   * timers, and background work. Called by LifecycleEngine exactly once before transitioning
   * to the `ready` stage. Mounted mode only.
   *
   * @returns {void | Promise<void>}
   */
  onMount? (): void | Promise<void>;

  /**
   * Optional: node unmount from GraphRuntime. Typically used to drop subscriptions and stop
   * side effects. Called by LifecycleEngine exactly once during shutdown. Mounted mode only.
   *
   * @returns {void | Promise<void>}
   */
  onUnmount? (): void | Promise<void>;

  /**
   * Optional: declarative subtree description with no side effects.
   * Called by GraphRuntime during materialization and reconcile.
   *
   * Forbidden inside: network, bus subscriptions, handler registration, mutating global state.
   *
   * @returns {VirtualServiceNode | VirtualServiceNode[] | null} One or more virtual nodes,
   *   or `null` if the subtree is empty.
   */
  compose? (): VirtualServiceNode | VirtualServiceNode[] | null;
}
