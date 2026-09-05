/* eslint-disable no-redeclare */
/**
 * Selector System with Memoization
 *
 * Implements a memoized selector system similar to the reselect library.
 * Selectors recompute only when dependencies change,
 * which optimizes performance of reactive subscriptions.
 *
 * @module Effectable/store/selector
 */

import { Selector, MemoizedSelector } from './types';

/**
 * Memoization result with extra methods
 */
interface MemoizationResult<F extends (...args: any[]) => any> {
  (...args: Parameters<F>): ReturnType<F>;
  resetMemoization(): void;
  recomputations(): number;
}

/**
 * Simple memoization for a single argument (state)
 *
 * Caches the function result based on a shallow equality check of the argument.
 * If the argument has not changed (shallow equal), returns the cached result.
 *
 * @template F - Type of the function to memoize
 * @param func - Function to memoize
 * @returns Memoized function with extra methods
 *
 * @example
 * const expensive = (state) => state.items.map(x => x * 2);
 * const memoized = defaultMemoize(expensive);
 *
 * memoized(state1); // Computed
 * memoized(state1); // Returns cache
 * memoized(state2); // Recomputed
 */
function defaultMemoize<F extends (arg: any) => any> (func: F): MemoizationResult<F> {
  let lastArg: any = null;
  let lastResult: any = null;
  let called = false;
  let recomputationCount = 0;

  const memoized = (arg: any) => {
    // If never called or the argument changed — recompute.
    // Only commit cache slots after `func` succeeds: if `func` throws after
    // `lastArg` was already updated, a later call with the same arg would
    // shallow-equal-hit and return a stale `lastResult` (silent wrong value).
    if (!called || !shallowEqual(arg, lastArg)) {
      const nextResult = func(arg);
      lastArg = arg;
      lastResult = nextResult;
      called = true;
      recomputationCount++;
    }
    return lastResult;
  };

  // Cache reset method
  memoized.resetMemoization = () => {
    lastArg = null;
    lastResult = null;
    called = false;
    recomputationCount = 0;
  };

  // Method returning recomputation count (for debugging)
  memoized.recomputations = () => recomputationCount;

  return memoized as MemoizationResult<F>;
}

/**
 * Shallow equality for primitives and objects
 *
 * Compares two values:
 * - For primitives uses ===
 * - For objects compares all top-level fields
 * - For arrays compares length and elements
 *
 * @param a - First value
 * @param b - Second value
 * @returns true if values are equal (shallow)
 */
function shallowEqual (a: any, b: any): boolean {
  // Strict equality (for primitives and references)
  if (a === b) {
    return true;
  }

  // Different types or null/undefined
  if (typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (a === null || b === null) {
    return false;
  }

  // For arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      return false;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        return false;
      }
    }
    return true;
  }

  // For objects
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);

  if (keysA.length !== keysB.length) {
    return false;
  }

  for (const key of keysA) {
    if (a[key] !== b[key]) {
      return false;
    }
  }

  return true;
}

/**
 * Creates a memoized selector (overload for 1 input selector)
 */
export function createSelector<S, R1, T> (
  selector1: Selector<S, R1>,
  combiner: (res1: R1) => T
): MemoizedSelector<S, T>;

/**
 * Creates a memoized selector (overload for 2 input selectors)
 */
export function createSelector<S, R1, R2, T> (
  selector1: Selector<S, R1>,
  selector2: Selector<S, R2>,
  combiner: (res1: R1, res2: R2) => T
): MemoizedSelector<S, T>;

/**
 * Creates a memoized selector (overload for 3 input selectors)
 */
export function createSelector<S, R1, R2, R3, T> (
  selector1: Selector<S, R1>,
  selector2: Selector<S, R2>,
  selector3: Selector<S, R3>,
  combiner: (res1: R1, res2: R2, res3: R3) => T
): MemoizedSelector<S, T>;

/**
 * Creates a memoized selector (overload for 4 input selectors)
 */
export function createSelector<S, R1, R2, R3, R4, T> (
  selector1: Selector<S, R1>,
  selector2: Selector<S, R2>,
  selector3: Selector<S, R3>,
  selector4: Selector<S, R4>,
  combiner: (res1: R1, res2: R2, res3: R3, res4: R4) => T
): MemoizedSelector<S, T>;

/**
 * Creates a memoized selector (overload for 5 input selectors)
 */
export function createSelector<S, R1, R2, R3, R4, R5, T> (
  selector1: Selector<S, R1>,
  selector2: Selector<S, R2>,
  selector3: Selector<S, R3>,
  selector4: Selector<S, R4>,
  selector5: Selector<S, R5>,
  combiner: (res1: R1, res2: R2, res3: R3, res4: R4, res5: R5) => T
): MemoizedSelector<S, T>;

/**
 * Creates a memoized selector (overload for an array of selectors)
 */
export function createSelector<S, T> (
  selectors: Selector<S, any>[],
  combiner: (...args: any[]) => T
): MemoizedSelector<S, T>;

/**
 * Creates a memoized selector
 *
 * Takes input selectors and a combiner function.
 * Input selectors extract dependencies from state.
 * Combiner combines input selector results into the final result.
 *
 * The selector recomputes only when:
 * - At least one input selector result changed (shallow equality)
 *
 * @template S - State type
 * @template T - Result type
 *
 * @param args - Input selectors + combiner function at the end
 * @returns Memoized selector
 *
 * @example
 * // Simple selector
 * const selectCount = createSelector(
 *   [(state) => state.count],
 *   (count) => count * 2
 * );
 *
 * @example
 * // Selector composition
 * const selectUsers = (state) => state.users;
 * const selectFilter = (state) => state.filter;
 *
 * const selectFilteredUsers = createSelector(
 *   [selectUsers, selectFilter],
 *   (users, filter) => users.filter(u => u.name.includes(filter))
 * );
 *
 * @example
 * // Usage with store.select()
 * store.select(selectFilteredUsers).subscribe(users => {
 *   console.log('Filtered users:', users);
 * });
 */
export function createSelector<S, T> (...args: any[]): MemoizedSelector<S, T> {
  // Last argument is the combiner function
  const combiner = args[args.length - 1] as (...args: any[]) => T;

  // Remaining arguments are input selectors
  // Two formats are supported:
  // 1. createSelector(sel1, sel2, combiner) - selectors as separate arguments
  // 2. createSelector([sel1, sel2], combiner) - selectors as an array
  let inputSelectors: Selector<S, any>[];

  if (Array.isArray(args[0])) {
    // Format: createSelector([sel1, sel2], combiner)
    inputSelectors = args[0];
  } else {
    // Format: createSelector(sel1, sel2, combiner)
    inputSelectors = args.slice(0, -1);
  }

  // Memoize the combiner function.
  // IMPORTANT: defaultMemoize memoizes on a SINGLE argument only, so
  // we pass the dependency array as one argument and then
  // "spread" it into the combiner (as in reselect).
  const memoizedCombiner = defaultMemoize((params: any[]) => combiner(...params));

  /**
   * Resulting selector
   *
   * Calls all input selectors, collects results into an array,
   * and passes them to the memoized combiner.
   */
  const selector = (state: S): T => {
    // Get results of all input selectors
    const params = inputSelectors.map((inputSelector) => inputSelector(state));

    // Apply the memoized combiner
    // Memoization is based on shallow equality of the params array
    return memoizedCombiner(params);
  };

  // Add methods for debugging and cache control
  const memoizedSelector = selector as MemoizedSelector<S, T>;

  memoizedSelector.resetMemoization = () => {
    memoizedCombiner.resetMemoization();
  };

  memoizedSelector.recomputations = () => {
    return memoizedCombiner.recomputations();
  };

  return memoizedSelector;
}

/**
 * Creates a structured selector from an object of selectors
 *
 * Convenient utility for creating a selector that returns an object
 * with results of several selectors.
 *
 * @template S - State type
 * @template T - Result type (object with selectors)
 *
 * @param selectorsObj - Object where keys are field names and values are selectors
 * @returns Memoized selector returning an object of results
 *
 * @example
 * const selectNavigation = createStructuredSelector({
 *   currentPath: (state) => state.navigation.currentPath,
 *   breadcrumb: (state) => state.navigation.breadcrumb,
 *   canGoBack: (state) => state.navigation.history.backStack.length > 0,
 * });
 *
 * // Result: { currentPath: '...', breadcrumb: [...], canGoBack: true }
 * store.select(selectNavigation).subscribe(nav => {
 *   console.log('Navigation:', nav);
 * });
 */
export function createStructuredSelector<S, T extends Record<string, any>> (
  selectorsObj: { [K in keyof T]: Selector<S, T[K]> }
): MemoizedSelector<S, T> {
  const keys = Object.keys(selectorsObj) as Array<keyof T>;
  const selectors = keys.map((key) => selectorsObj[key]);

  return createSelector(selectors, (...values: any[]) => {
    const result = {} as T;
    keys.forEach((key, index) => {
      result[key] = values[index];
    });
    return result;
  });
}
