/**
 * Redux Store Creator with RxJS Support
 *
 * Implements createStore with strict Redux v4 compatibility
 * plus reactive RxJS extensions (state$, select).
 *
 * @module Effectable/store/createStore
 */

import { Observable, Subject } from 'rxjs';
import { map, distinctUntilChanged } from 'rxjs/operators';
import { Store, Reducer, Action, StoreEnhancer, Selector } from './types';

/**
 * Creates a Redux Store with RxJS support
 *
 * Primary function for creating application state storage.
 * Compatible with Redux v4 API, with an Observable state stream
 * for reactive subscriptions.
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

  // Canonical current state for getState() and for replay to new state$/select
  // subscribers. Kept in sync before notification so a nested dispatch from a
  // subscriber always reduces from the latest committed state, even while an outer
  // notification is still delivering its value to later observers.
  let currentState: S = initialState;

  // Notification channel only (no BehaviorSubject replay buffer). New subscribers
  // replay `currentState` via `stateObservable$` so they never see a stale
  // BehaviorSubject `_value` after nested dispatch coalescing (#86 residual).
  const notifications$ = new Subject<S>();

  // Flag to prevent dispatch while a reducer is running
  let isDispatching = false;

  // Flag to track if the store has been destroyed
  let isDestroyed = false;

  // Nested dispatch from a state$/select subscriber must not leave later observers
  // with a stale outer emission AFTER the nested (newer) state. Subject.next is
  // re-entrant: outer next(S1) → subscriber dispatches → next(S2) → remaining
  // outer observers still receive S1 after S2. Publish through this gate so the
  // outermost notify loop always finishes on the latest committed state.
  let isPublishing = false;
  let publishAgain = false;
  // destroy() during state$.next otherwise calls complete() mid-delivery and
  // drops not-yet-notified observers for that emission (including connect select
  // subscribers whose onUpdate triggered destroy). Defer complete until publish ends.
  let pendingDestroyComplete = false;

  /**
   * Public state stream: replay committed `currentState` on subscribe, then
   * forward publishes. After destroy, new subscribers complete with no next
   * (matches prior BehaviorSubject-after-complete contract used by connect).
   */
  const stateObservable$ = new Observable<S>((subscriber) => {
    if (isDestroyed) {
      subscriber.complete();
      return undefined;
    }
    subscriber.next(currentState);
    return notifications$.subscribe(subscriber);
  });

  /**
   * Commits `nextState` and notifies observers without letting a nested
   * dispatch leave a stale outer emission as the final observed value.
   *
   * @param {S} nextState - state to commit and publish
   * @returns {void}
   */
  function publishState (nextState: S): void {
    currentState = nextState;

    if (isPublishing) {
      publishAgain = true;
      return;
    }

    isPublishing = true;
    try {
      do {
        publishAgain = false;
        notifications$.next(currentState);
      } while (publishAgain);
    } finally {
      isPublishing = false;
      if (pendingDestroyComplete) {
        pendingDestroyComplete = false;
        notifications$.complete();
      }
    }
  }

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

    // Reject class instances and Object.create(null) (strict Redux v4 behavior)
    // Real Redux only accepts objects with Object.prototype
    const proto = Object.getPrototypeOf(action);
    if (proto !== Object.prototype) {
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

    // Emit after reduce completes. Nested dispatch from a subscriber is coalesced
    // so observers never end on a stale outer state after a newer nested state.
    publishState(newState);

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
    return currentState;
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
    return stateObservable$.pipe(
      map(selectorFn),
      // Object.is so stable NaN (and -0/+0) compare equal — default === re-emits
      // NaN on every dispatch and can infinite-loop a subscriber that dispatches.
      distinctUntilChanged(Object.is)
    );
  };

  /**
   * Shuts down the Store and releases resources
   *
   * Completes the notification subject, which ends all subscriptions.
   * After destroy() the Store is no longer usable.
   *
   * @example
   * // On application shutdown
   * store.destroy();
   */
  const destroy = (): void => {
    if (isDestroyed) {
      return;
    }
    isDestroyed = true;
    // If a subscriber destroys mid-notify, finish delivering this emission first.
    if (isPublishing) {
      pendingDestroyComplete = true;
      return;
    }
    notifications$.complete();
  };

  return {
    dispatch,
    getState,
    state$: stateObservable$,
    select,
    destroy,
  };
}
