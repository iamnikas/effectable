/**
 * Redux Store Creator with RxJS Support
 *
 * Implements createStore with strict Redux v4 compatibility
 * plus reactive RxJS extensions (state$, select).
 *
 * @module Effectable/store/createStore
 */

import { BehaviorSubject, Observable } from 'rxjs';
import { map, distinctUntilChanged } from 'rxjs/operators';
import { Store, Reducer, Action, StoreEnhancer, Selector } from './types';

/**
 * Creates a Redux Store with RxJS support
 *
 * Primary function for creating application state storage.
 * Compatible with Redux v4 API, but uses BehaviorSubject for
 * reactive state management.
 *
 * @template S - Store state type
 * @template A - Action type (must extend the base Action)
 *
 * @param reducer - Root reducer function that handles actions
 * @param initialState - Initial application state
 * @param enhancer - Store enhancer, optional
 * @returns Store object with dispatch, getState, state$, select, destroy
 *
 * @example
 * // Simple Store without middleware
 * const store = createStore(rootReducer, initialState);
 *
 * @example
 * // Using the Store
 * store.dispatch({ type: 'INCREMENT', payload: 1 });
 * store.state$.subscribe(state => console.log('State:', state));
 * const count$ = store.select(state => state.count);
 */
export function createStore<S, A extends Action> (
  reducer: Reducer<S, A>,
  initialState: S,
  enhancer?: StoreEnhancer<S, A>
): Store<S, A> {
  // If an enhancer is provided (e.g. from applyMiddleware), delegate creation
  if (enhancer) {
    return enhancer(createStore)(reducer, initialState);
  }

  // Internal BehaviorSubject for reactive state
  // BehaviorSubject ensures new subscribers receive the current value
  const state$ = new BehaviorSubject<S>(initialState);

  // Flag to prevent dispatch while a reducer is running
  let isDispatching = false;

  // Flag to track if the store has been destroyed
  let isDestroyed = false;

  /**
   * Base dispatch without middleware
   *
   * Calls the reducer with the current state and action,
   * gets the new state, and emits it on the state$ Observable.
   *
   * @param action - Action to process
   * @returns The same action
   */
  function dispatch<B extends A> (action: B): B {
    // Guard: store has been destroyed
    if (isDestroyed) {
      throw new Error(
        'Cannot dispatch an action after the store has been destroyed.'
      );
    }

    // Action validation - strict plain object check (Redux-compatible)
    if (typeof action !== 'object' || action === null) {
      throw new Error(
        'Actions must be plain objects. Use custom middleware for async actions.'
      );
    }

    // Reject arrays (typeof [] === 'object' but not a plain object)
    if (Array.isArray(action)) {
      throw new Error(
        'Actions must be plain objects. Use custom middleware for async actions.'
      );
    }

    // Reject class instances (only accept plain objects and Object.create(null))
    const proto = Object.getPrototypeOf(action);
    if (proto !== null && proto !== Object.prototype) {
      throw new Error(
        'Actions must be plain objects. Use custom middleware for async actions.'
      );
    }

    if (typeof action.type === 'undefined') {
      throw new Error(
        'Actions may not have an undefined "type" property. Have you misspelled a constant?'
      );
    }

    // Reentrancy check (dispatch called inside a reducer)
    if (isDispatching) {
      throw new Error('Reducers may not dispatch actions.');
    }

    let newState: S;
    try {
      isDispatching = true;

      // Get current state
      const currentState = state$.getValue();

      // Call reducer to get the new state
      newState = reducer(currentState, action);

      // Redux-compatible: reject undefined state from reducer
      if (typeof newState === 'undefined') {
        throw new Error(
          `Reducer returned undefined when handling action "${action.type}". ` +
          'To ignore an action, you must explicitly return the previous state.'
        );
      }
    } finally {
      // Important: reset the flag before notifying subscribers
      // so they can safely dispatch follow-up actions (as in Redux).
      isDispatching = false;
    }

    // Emit the new state on the Observable after the reduce phase completes.
    state$.next(newState);

    return action;
  }

  /**
   * Method to get the current state synchronously
   *
   * @returns Current Store state
   */
  const getState = (): S => {
    if (isDestroyed) {
      throw new Error(
        'Cannot access state after the store has been destroyed.'
      );
    }
    return state$.getValue();
  };

  /**
   * Universal select method for applying selectors
   *
   * Applies a selector function to each new state
   * and automatically filters unchanged results via distinctUntilChanged.
   *
   * @template T - Selector result type
   * @param selectorFn - Selector function
   * @returns Observable of the selector result
   *
   * @example
   * const currentPath$ = store.select(state => state.navigation.currentPath);
   * currentPath$.subscribe(path => console.log('Path:', path));
   */
  const select = <T>(selectorFn: Selector<S, T>): Observable<T> => {
    return state$.pipe(
      map(selectorFn),
      distinctUntilChanged()
    );
  };

  /**
   * Shuts down the Store and releases resources
   *
   * Calls complete() on the BehaviorSubject, which ends all subscriptions.
   * After destroy() the Store is no longer usable.
   *
   * @example
   * // On application shutdown
   * store.destroy();
   */
  const destroy = (): void => {
    isDestroyed = true;
    state$.complete();
  };

  return {
    dispatch,
    getState,
    state$: state$.asObservable(), // Return as Observable, not BehaviorSubject
    select,
    destroy,
  };
}
