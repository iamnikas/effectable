/**
 * Redux-RxJS Store Types
 *
 * Defines types for a Redux-like store with RxJS support.
 * Maximum compatibility with Redux v4 API plus reactive extensions.
 *
 * @module Effectable/store/types
 */

import { Observable } from 'rxjs';

// ============================================================================
// Basic Types
// ============================================================================

/**
 * Base Action type
 *
 * All actions must have a type field and an optional payload.
 */
export interface Action<T = any> {
  type: string;
  payload?: T;
}

/**
 * Base action for middleware and default dispatch.
 *
 * Used as “any action” with a required `type`
 * and an optional `payload`.
 */
export interface AnyAction extends Action<unknown> {}

/**
 * Reducer function
 *
 * Takes the current state and an action, returns the new state.
 * Must be a pure function (no side-effects).
 *
 * @template S - State type
 * @template A - Action type
 */
export type Reducer<S = any, A extends Action = Action> = (
  state: S,
  action: A
) => S;

/**
 * Dispatch function
 *
 * Sends an action to the Store for processing through the middleware chain and reducer.
 * Supports both synchronous and asynchronous middleware.
 *
 * @template A - Action type
 */
export type Dispatch<A = AnyAction> = (action: A) => A | Promise<A>;

/**
 * Dispatch as a Store method with an optional generic to narrow the action type at the call site.
 * Allows calling store.dispatch&lt;ConcreteAction&gt;({ type, payload }) without a type cast.
 *
 * @template A - Base action type (e.g. RootAction)
 */
export type DispatchMethod<A extends Action = Action> = <B extends A = A>(action: B) => B | Promise<B>;

/**
 * Selector function
 *
 * Extracts a slice of state from the Store.
 * Can be used for memoization and composition.
 *
 * @template S - State type
 * @template R - Result type
 */
export type Selector<S, R> = (state: S) => R;

/**
 * Parametric Selector (with extra parameters)
 *
 * A selector that takes not only state but also additional parameters.
 *
 * @template S - State type
 * @template P - Parameters type
 * @template R - Result type
 */
export type ParametricSelector<S, P, R> = (state: S, props: P) => R;

// ============================================================================
// Store Types
// ============================================================================

/**
 * Store Creator
 *
 * Function that creates a Store. Used for typing createStore.
 */
export type StoreCreator<S = any, A extends Action = Action> = (
  reducer: Reducer<S, A>,
  initialState: S
) => Store<S, A>;

/**
 * Store Enhancer
 *
 * Higher-order function for modifying Store behavior.
 * Used to apply middleware via applyMiddleware.
 */
export type StoreEnhancer<S = any, A extends Action = Action> = (
  createStore: StoreCreator<S, A>
) => StoreCreator<S, A>;

/**
 * Store interface
 *
 * Main Redux Store interface with RxJS extensions.
 *
 * @template S - State type
 * @template A - Action type
 */
export interface Store<S = any, A extends Action = Action> {
  /**
   * Dispatches an action to the Store.
   * Supports an optional generic to narrow the type: store.dispatch&lt;ConcreteAction&gt;({ type, payload }).
   *
   * The action goes through the middleware chain, then the reducer,
   * and the new state is emitted on the state$ Observable.
   *
   * @param action - Action to process
   * @returns The same action (for chaining)
   */
  dispatch: DispatchMethod<A>;

  /**
   * Returns the current state synchronously
   *
   * Useful for taking a state snapshot without subscribing.
   *
   * @returns Current Store state
   */
  getState(): S;

  /**
   * Observable of the current state (RxJS extension)
   *
   * Emits a new value on every state change.
   * Starts with the current state (BehaviorSubject).
   *
   * @example
   * store.state$.subscribe(state => {
   *   console.log('State changed:', state);
   * });
   */
  state$: Observable<S>;

  /**
   * Universal method for applying selectors (RxJS extension)
   *
   * Automatically applies distinctUntilChanged to avoid
   * unnecessary emissions when the selector result is unchanged.
   *
   * @template T - Selector result type
   * @param selectorFn - Selector function
   * @returns Observable of the selector result
   *
   * @example
   * const currentPath$ = store.select(state => state.navigation.currentPath);
   * currentPath$.subscribe(path => console.log('Path:', path));
   */
  select<T>(selectorFn: Selector<S, T>): Observable<T>;

  /**
   * Completes all subscriptions and cleans up resources
   *
   * After destroy() the Store is no longer usable.
   * Call when unmounting the app or in tests.
   */
  destroy(): void;
}

// ============================================================================
// Middleware Types
// ============================================================================

/**
 * Middleware API
 *
 * API provided to each middleware: dispatch and getState.
 * Calling api.dispatch(action) runs the action through the entire chain again.
 *
 * @template D - Dispatch type
 * @template S - State type
 */
export interface MiddlewareAPI<D = Dispatch, S = unknown> {
  /**
   * Dispatch function for sending new actions
   *
   * IMPORTANT: This is the wrapped dispatch that goes through the middleware chain.
   * Can be used to dispatch additional actions inside middleware.
   */
  dispatch: D;

  /**
   * Function to get the current state
   *
   * Returns a state snapshot at the time of the call.
   */
  getState(): S;
}

/**
 * Middleware function
 *
 * Redux-style middleware with a triple-curried signature:
 * (store) => (next) => (action) => result
 *
 * Middleware can:
 * - Intercept actions
 * - Perform side-effects
 * - Dispatch new actions via api.dispatch()
 * - Read state via api.getState()
 * - Modify or block actions
 * - Call next() multiple times
 * - Use async/await
 *
 * @template S - State type
 * @template A - Action type
 *
 * @example
 * const loggingMiddleware: Middleware = (store) => (next) => (action) => {
 *   console.log('Action:', action.type);
 *   const result = next(action);
 *   console.log('New state:', store.getState());
 *   return result;
 * };
 *
 * @example
 * // Async middleware
 * const asyncMiddleware: Middleware = (store) => (next) => async (action) => {
 *   const result = next(action);
 *   await saveToServer(action);
 *   return result;
 * };
 */
export interface Middleware<
  _DispatchExt = {},
  S = unknown,
  D = Dispatch
> {
  /**
   * Creates middleware in redux-style format `(api) => (next) => (action)`.
   * `next(action)` forwards the action down the current chain.
   * `api.dispatch(action)` starts the action from the beginning of the entire chain.
   *
   * The action handler may be synchronous or asynchronous.
   *
   * @param {MiddlewareAPI<D, S>} api - Middleware API: dispatch, getState
   * @returns {(next: D) => (action: unknown) => unknown | Promise<unknown>} wrapper over dispatch
   */
  (api: MiddlewareAPI<D, S>): (next: D) => (action: unknown) => unknown | Promise<unknown>;
}

/**
 * Middleware argument accepted by enhancer-mode `applyMiddleware`.
 * Matches runtime: a middleware function or a module namespace `{ default: fn }`.
 */
export type MiddlewareInput<
  DispatchExt = {},
  S = unknown,
  D = Dispatch
> = Middleware<DispatchExt, S, D> | { default: Middleware<DispatchExt, S, D> };

// ============================================================================
// Selector Types
// ============================================================================

/**
 * Memoized selector
 *
 * Selector with extra methods for memoization control
 * and performance debugging.
 *
 * @template S - State type
 * @template R - Result type
 */
export interface MemoizedSelector<S, R> extends Selector<S, R> {
  /**
   * Resets the selector cache
   *
   * After calling, the next selector invocation will recompute
   * regardless of input data.
   *
   * Useful for testing or when you need to force
   * a result recomputation.
   */
  resetMemoization(): void;

  /**
   * Returns the number of combiner function calls
   *
   * Used for debugging and optimization.
   * If recomputations() grows too quickly,
   * the selector may need optimization.
   *
   * @returns Recomputation count
   */
  recomputations(): number;
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard to check whether an object is an Action
 */
export function isAction (obj: any): obj is Action {
  return typeof obj === 'object' && obj !== null && typeof obj.type === 'string';
}

/**
 * Type guard to check whether a function is Middleware
 */
export function isMiddleware<DispatchExt = {}, S = unknown, D = Dispatch> (
  fn: unknown
): fn is Middleware<DispatchExt, S, D> {
  return typeof fn === 'function';
}
