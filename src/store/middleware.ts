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

function wrapDispatch<S> (
  api: MiddlewareAPI<DispatchFn, S>,
  rawDispatch: DispatchFn,
  middlewares: Array<unknown>
): DispatchFn {
  const chain = middlewares.reduceRight<DispatchFn>(
    (next, middleware) => {
      const coerced = coerceMiddleware<S, DispatchFn>(middleware);
      return coerced(api)(next);
    },
    rawDispatch
  );

  api.dispatch = chain;
  return chain;
}

function unboundDispatch (action: unknown): unknown {
  return action;
}

/**
 * Supports two modes:
 * 1. `applyMiddleware(api, rawDispatch, ...middlewares)` — wrap an existing dispatch
 * 2. `applyMiddleware(...middlewares)` — legacy enhancer-style for compatibility
 * 3. Middleware may arrive as default-export functions from slice modules.
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
    return wrapDispatch(api, rawDispatch, middlewares);
  }

  return (createStore: StoreCreator<unknown, Action>) =>
    (reducer: Reducer<unknown, Action>, initialState: unknown) => {
      const store = createStore(reducer, initialState);
      const api: MiddlewareAPI<DispatchFn, unknown> = {
        getState: store.getState,
        dispatch: unboundDispatch,
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
