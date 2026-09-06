/**
 * Redux Middleware System
 *
 * Implements a middleware system similar to Redux.
 * Middleware can intercept actions, perform side-effects,
 * run async operations, and dispatch new actions.
 *
 * @module Effectable/store/middleware
 */

import { Action, isMiddleware, Middleware, MiddlewareAPI, MiddlewareInput, Reducer, StoreCreator, StoreEnhancer } from './types';

/**
 * Dispatch-shaped function used to type the wrap-mode chain.
 * Method-syntax bivariance lets {@link DispatchMethod} satisfy this type under
 * `strictFunctionTypes`, so wrap-mode `D extends DispatchFn` typechecks without `as`.
 */
type DispatchFn = {
  bivarianceHack (action: unknown): unknown | Promise<unknown>;
}['bivarianceHack'];

function hasGetState (value: unknown): value is MiddlewareAPI<DispatchFn> {
  return typeof value === 'object' && value !== null && 'getState' in value;
}

function isWrapModeArgs (
  args: unknown[]
): args is [MiddlewareAPI<DispatchFn>, DispatchFn, ...unknown[]] {
  return args.length > 1 && hasGetState(args[0]);
}

/**
 * Normalizes middleware: a function or a default-export module `{ default: fn }`.
 *
 * @param {unknown} middleware - middleware or module-namespace with default
 * @returns {Middleware<unknown, S, D>}
 */
function coerceMiddleware<S, D extends DispatchFn> (middleware: unknown): Middleware<unknown, S, D> {
  if (isMiddleware<unknown, S, D>(middleware)) {
    return middleware;
  }

  if (typeof middleware === 'object' && middleware !== null && Object.hasOwn(middleware, 'default')) {
    const defaultExport = Reflect.get(middleware, 'default');
    if (isMiddleware<unknown, S, D>(defaultExport)) {
      return defaultExport;
    }
  }

  throw new Error(
    'Expected a middleware function or a module with default-exported middleware function.'
  );
}

function dispatchWhileConstructing (_action: unknown): unknown {
  throw new Error(
    'Dispatching while constructing your middleware is not allowed. ' +
    'Other middleware would not be applied to this dispatch.'
  );
}

/**
 * Builds the middleware chain and wires `api.dispatch`.
 *
 * Redux contract: `api.dispatch` must be a **stable late-bound forwarder** while
 * middleware factories run. Factories often capture `dispatch` by destructuring
 * (`({ dispatch }) => ...`). If `api.dispatch` were the construction thrower
 * (or later replaced by the chain under a new function identity), that capture
 * would keep throwing forever after setup. The forwarder always calls through a
 * mutable slot: thrower during construction, finished chain afterwards.
 *
 * @param {MiddlewareAPI<DispatchFn, S>} api - middleware API object (mutated)
 * @param {DispatchFn} rawDispatch - store dispatch at the bottom of the chain
 * @param {Array<unknown>} middlewares - middleware factories / module namespaces
 * @returns {DispatchFn} composed dispatch chain (also reachable via `api.dispatch`)
 */
function wrapDispatch<S> (
  api: MiddlewareAPI<DispatchFn, S>,
  rawDispatch: DispatchFn,
  middlewares: Array<unknown>
): DispatchFn {
  // Slot starts as the construction thrower; swapped for `chain` after factories run.
  let activeDispatch: DispatchFn = dispatchWhileConstructing;
  // Stable identity captured by middleware factories that destructure `dispatch`.
  const forwardDispatch: DispatchFn = (action: unknown) => activeDispatch(action);
  api.dispatch = forwardDispatch;

  const chain = middlewares.reduceRight<DispatchFn>(
    (next, middleware) => {
      const coerced = coerceMiddleware<S, DispatchFn>(middleware);
      return coerced(api)(next);
    },
    rawDispatch
  );

  activeDispatch = chain;
  // Keep the forwarder on `api` so destructured captures and `api.dispatch` stay valid.
  api.dispatch = forwardDispatch;
  return chain;
}

/**
 * Supports two modes:
 * 1. `applyMiddleware(api, rawDispatch, ...middlewares)` — wrap an existing dispatch
 * 2. `applyMiddleware(...middlewares)` — legacy enhancer-style for compatibility
 * 3. Middleware may arrive as default-export functions from slice modules.
 *
 * Construction invariant (both modes): while middleware factories run, `api.dispatch`
 * must not reach `rawDispatch` or a half-built chain. Calling `dispatch` during
 * construction throws (Redux-compatible). Applies to wrap-mode and enhancer-style.
 *
 * Wrap-mode overload is first so `applyMiddleware(api, rawDispatch, ...)` is not
 * parsed as enhancer-style rest middlewares.
 */
export function applyMiddleware<S, D extends DispatchFn> (
  api: MiddlewareAPI<D, S>,
  rawDispatch: D,
  ...middlewares: unknown[]
): D;
export function applyMiddleware (): StoreEnhancer;
export function applyMiddleware<S = unknown, A extends Action = Action> (
  ...middlewares: Array<MiddlewareInput<unknown, S>>
): StoreEnhancer<S, A>;
export function applyMiddleware (...args: unknown[]): unknown {
  if (isWrapModeArgs(args)) {
    const [api, rawDispatch, ...middlewares] = args;
    // Same construction invariant as enhancer mode (PR #55 / Redux): while
    // middleware factories run, the late-bound `api.dispatch` forwarder must not
    // reach rawDispatch / a half-built chain. `wrapDispatch` installs that
    // forwarder; restore the caller's previous `api.dispatch` if setup throws.
    const previousDispatch = api.dispatch;
    try {
      return wrapDispatch(api, rawDispatch, middlewares);
    } catch (error) {
      api.dispatch = previousDispatch;
      throw error;
    }
  }

  return (createStore: StoreCreator<unknown, Action>) =>
    (reducer: Reducer<unknown, Action>, initialState: unknown) => {
      const store = createStore(reducer, initialState);
      // Placeholder; `wrapDispatch` immediately replaces this with a late-bound
      // forwarder before any middleware factory runs.
      const api: MiddlewareAPI<DispatchFn, unknown> = {
        getState: store.getState,
        dispatch: dispatchWhileConstructing,
      };
      const dispatch = wrapDispatch(api, store.dispatch, args);
      return {
        ...store,
        dispatch,
      };
    };
}

/**
 * Compose function for function composition
 *
 * Helper for functional composition.
 * Takes an array of functions and returns their composition.
 *
 * @template T - Argument and result type of the functions
 * @param funcs - Array of functions to compose
 * @returns Composed function
 *
 * @example
 * const addOne = (x) => x + 1;
 * const double = (x) => x * 2;
 * const composed = compose(addOne, double);
 * composed(5); // => (5 * 2) + 1 = 11
 *
 * @remarks
 * Used internally by applyMiddleware to build the middleware chain.
 * Rarely needed for external use.
 */
export function compose<T> (...funcs: Array<(arg: T) => T>): (arg: T) => T {
  // No functions — return identity
  if (funcs.length === 0) {
    return (arg: T) => arg;
  }

  // Single function — return it
  if (funcs.length === 1) {
    return funcs[0];
  }

  // Multiple functions — compose via reduce
  return funcs.reduce(
    (a, b) =>
      (arg: T) =>
        a(b(arg))
  );
}
