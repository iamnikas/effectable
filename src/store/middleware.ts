/**
 * Redux Middleware System
 *
 * Implements a middleware system similar to Redux.
 * Middleware can intercept actions, perform side-effects,
 * run async operations, and dispatch new actions.
 *
 * @module Effectable/store/middleware
 */

import { Action, DispatchMethod, Middleware, MiddlewareAPI, Reducer, Store, StoreCreator, StoreEnhancer } from './types';

/**
 * Normalizes middleware: a function or a default-export module `{ default: fn }`.
 *
 * @param {unknown} middleware - middleware or module-namespace with default
 * @returns {Middleware<unknown, S, D>}
 */
function coerceMiddleware<S, D> (middleware: unknown): Middleware<unknown, S, D> {
  if (typeof middleware === 'function') {
    return middleware as Middleware<unknown, S, D>;
  }

  if (typeof middleware === 'object' && middleware !== null && Object.hasOwn(middleware, 'default')) {
    const defaultExport = Reflect.get(middleware, 'default');
    if (typeof defaultExport === 'function') {
      return defaultExport as Middleware<unknown, S, D>;
    }
  }

  throw new Error(
    'Expected a middleware function or a module with default-exported middleware function.'
  );
}

function wrapDispatch<S, D> (
  api: MiddlewareAPI<D, S>,
  rawDispatch: D,
  middlewares: Array<unknown>
): D {
  const chain = middlewares.reduceRight<(action: unknown) => unknown | Promise<unknown>>(
    (next, middleware) => {
      const coerced = coerceMiddleware<S, D>(middleware);
      // FIXME: teach middleware so action can carry a type and the output has a known type
      const resolvedMiddleware = coerced(api) as (next: D) => (action: unknown) => unknown | Promise<unknown>;
      return resolvedMiddleware(next as D) as (action: unknown) => unknown | Promise<unknown>;
    },
    rawDispatch as (action: unknown) => unknown | Promise<unknown>
  );

  (api as { dispatch: D }).dispatch = chain as D;
  return chain as D;
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
export function applyMiddleware<S, D> (
  api: MiddlewareAPI<D, S>,
  rawDispatch: D,
  ...middlewares: unknown[]
): D;
export function applyMiddleware (): StoreEnhancer;
export function applyMiddleware<S = unknown, A extends Action = Action> (
  ...middlewares: Array<Middleware<unknown, S>>
): StoreEnhancer<S, A>;
export function applyMiddleware (...args: unknown[]): unknown {
  if (args.length > 1 && typeof args[0] === 'object' && args[0] !== null && 'getState' in (args[0] as object)) {
    const [api, rawDispatch, ...middlewares] = args as [MiddlewareAPI<unknown, unknown>, unknown, ...Array<Middleware<unknown, unknown, unknown>>];
    return wrapDispatch(api, rawDispatch, middlewares);
  }

  const middlewares = args as Array<Middleware<unknown, unknown, DispatchMethod<Action>>>;
  return (createStore: StoreCreator<unknown, Action>) =>
    (reducer: Reducer<unknown, Action>, initialState: unknown): Store<unknown, Action> => {
      const store = createStore(reducer, initialState);
      const api: MiddlewareAPI<DispatchMethod<Action>, unknown> = {
        getState: store.getState,
        dispatch: null as unknown as DispatchMethod<Action>,
      };
      const dispatch = wrapDispatch(api, store.dispatch, middlewares);
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
