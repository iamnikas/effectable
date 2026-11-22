/**
 * Entity tests for createStore (dispatch, state$, select, destroy, enhancer contract).
 *
 * @module Effectable/store/createStore.entity.test
 */

import {
  applyMiddleware,
  createSelector,
  createStore,
  isAction,
  isMiddleware,
} from 'Effectable';
import type {
  AnyAction,
  Middleware,
  Reducer,
  Store,
  StoreCreator,
  StoreEnhancer,
} from 'Effectable';
import { Subject } from 'rxjs';

interface CounterState {
  count: number;
  label: string;
}

type CounterAction =
  | { type: 'INC'; payload?: undefined }
  | { type: 'SET'; payload: number }
  | { type: 'NOOP'; payload?: undefined }
  | { type: 'TRIGGER_REENTRANT'; payload?: undefined }
  | { type: 'FOLLOW_UP'; payload?: undefined }
  | { type: 'THROW'; payload?: undefined };

/**
 * Simple counter reducer and helper action types.
 *
 * @param {CounterState} state - current state
 * @param {CounterAction} action - action
 * @returns {CounterState} new state
 */
function counterReducer (state: CounterState, action: CounterAction): CounterState {
  if (action.type === 'INC') {
    return { ...state, count: state.count + 1 };
  }
  if (action.type === 'SET') {
    return { ...state, count: action.payload };
  }
  if (action.type === 'FOLLOW_UP') {
    return { ...state, count: state.count + 10 };
  }
  if (action.type === 'THROW') {
    throw new Error('reducer boom');
  }
  return state;
}

const initialCounterState: CounterState = { count: 0, label: 'main' };

/**
 * Normalizes an unknown action for passing to next middleware.
 *
 * @param {unknown} raw - input action
 * @returns {AnyAction} action with a required string type
 */
function expectAnyAction (raw: unknown): AnyAction {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('Expected action object');
  }
  if (!('type' in raw)) {
    throw new Error('Expected type field');
  }
  const typeField = raw.type;
  if (typeof typeField !== 'string') {
    throw new Error('Expected string type');
  }
  const result: AnyAction = { type: typeField };
  if ('payload' in raw) {
    result.payload = raw.payload;
  }
  return result;
}

describe('createStore', () => {
  describe('dispatch and getState (B01)', () => {
    it('dispatch updates synchronous getState', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      expect(store.getState()).toEqual(initialCounterState);
      store.dispatch({ type: 'INC' });
      expect(store.getState()).toEqual({ count: 1, label: 'main' });
      store.dispatch({ type: 'SET', payload: 42 });
      expect(store.getState().count).toBe(42);
      store.destroy();
    });
  });

  describe('state$ (B02, B10)', () => {
    it('state$ emits the new state after dispatch', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );
      const seen: CounterState[] = [];
      const sub = store.state$.subscribe((state) => {
        seen.push(state);
      });

      store.dispatch({ type: 'INC' });
      store.dispatch({ type: 'SET', payload: 5 });

      expect(seen.length).toBeGreaterThanOrEqual(3);
      expect(seen[seen.length - 1]).toEqual({ count: 5, label: 'main' });

      sub.unsubscribe();
      store.destroy();
    });

    it('with the same reference from reducer state$.next still notifies subscribers', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );
      let notifyCount = 0;
      const sub = store.state$.subscribe(() => {
        notifyCount += 1;
      });

      const before = notifyCount;
      store.dispatch({ type: 'NOOP' });
      expect(notifyCount).toBe(before + 1);

      sub.unsubscribe();
      store.destroy();
    });
  });

  describe('select and distinctUntilChanged', () => {
    it('select does not re-emit if the selector result did not change', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );
      const labelValues: string[] = [];
      const sub = store.select((state) => {
        return state.label;
      }).subscribe((label) => {
        labelValues.push(label);
      });

      store.dispatch({ type: 'INC' });
      store.dispatch({ type: 'SET', payload: 99 });

      expect(labelValues).toEqual(['main']);

      sub.unsubscribe();
      store.destroy();
    });

    it('select emits when the selector result changes', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );
      const counts: number[] = [];
      const sub = store.select((state) => {
        return state.count;
      }).subscribe((count) => {
        counts.push(count);
      });

      store.dispatch({ type: 'INC' });
      store.dispatch({ type: 'INC' });
      store.dispatch({ type: 'SET', payload: 10 });

      expect(counts).toEqual([0, 1, 2, 10]);

      sub.unsubscribe();
      store.destroy();
    });
  });

  describe('action validation (B04)', () => {
    it('dispatch of a non-object throws', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      expect(() => {
        store.dispatch(null as unknown as CounterAction);
      }).toThrow(/plain objects/);

      expect(() => {
        store.dispatch(undefined as unknown as CounterAction);
      }).toThrow(/plain objects/);

      expect(() => {
        store.dispatch('INC' as unknown as CounterAction);
      }).toThrow(/plain objects/);

      store.destroy();
    });

    it('dispatch without type throws', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      expect(() => {
        store.dispatch({ payload: 1 } as unknown as CounterAction);
      }).toThrow(/undefined "type"/);

      store.destroy();
    });

    it('dispatch with type: undefined throws', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      expect(() => {
        store.dispatch({ type: undefined } as unknown as CounterAction);
      }).toThrow(/undefined "type"/);

      store.destroy();
    });

    it('dispatch of an array throws (strict plain object check)', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      expect(() => {
        store.dispatch([{ type: 'INC' }] as unknown as CounterAction);
      }).toThrow(/plain objects/);

      store.destroy();
    });

    it('dispatch of a class instance throws (strict plain object check)', () => {
      class ActionClass {
        type = 'INC';
      }

      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      expect(() => {
        store.dispatch(new ActionClass() as unknown as CounterAction);
      }).toThrow(/plain objects/);

      store.destroy();
    });

    it('dispatch of Object.create(null) throws (strict Redux v4 behavior)', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      const action = Object.create(null) as CounterAction;
      action.type = 'INC';

      expect(() => {
        store.dispatch(action);
      }).toThrow(/plain objects/);

      store.destroy();
    });
  });

  describe('reducer undefined validation (Redux-compatible)', () => {
    it('reducer returning undefined throws', () => {
      const badReducer = (): CounterState => {
        return undefined as unknown as CounterState;
      };

      const store = createStore<CounterState, CounterAction>(
        badReducer,
        initialCounterState,
      );

      expect(() => {
        store.dispatch({ type: 'INC' });
      }).toThrow(/Reducer returned undefined/);

      store.destroy();
    });

    it('reducer returning undefined for specific action throws', () => {
      const conditionalBadReducer = (
        state: CounterState,
        action: CounterAction,
      ): CounterState => {
        if (action.type === 'SET') {
          return undefined as unknown as CounterState;
        }
        return state;
      };

      const store = createStore<CounterState, CounterAction>(
        conditionalBadReducer,
        initialCounterState,
      );

      store.dispatch({ type: 'INC' });
      expect(store.getState().count).toBe(0);

      expect(() => {
        store.dispatch({ type: 'SET', payload: 5 });
      }).toThrow(/Reducer returned undefined when handling action "SET"/);

      store.destroy();
    });
  });

  describe('post-destroy guards (Redux-compatible behavior)', () => {
    it('dispatch after destroy throws', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      store.destroy();

      expect(() => {
        store.dispatch({ type: 'INC' });
      }).toThrow(/Cannot dispatch.*after.*destroyed/);
    });

    it('getState after destroy throws', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      store.destroy();

      expect(() => {
        store.getState();
      }).toThrow(/Cannot access state.*after.*destroyed/);
    });
  });

  describe('reentrancy and subscribers (B05, B06)', () => {
    it('nested dispatch from reducer throws', () => {
      let outerDispatch: Store<CounterState, CounterAction>['dispatch'] | null = null;

      const reentrantReducer: Reducer<CounterState, CounterAction> = (
        state,
        action,
      ) => {
        if (action.type === 'TRIGGER_REENTRANT') {
          if (outerDispatch === null) {
            throw new Error('dispatch not wired');
          }
          outerDispatch({ type: 'INC' });
        }
        return state;
      };

      const store = createStore(reentrantReducer, initialCounterState);
      outerDispatch = store.dispatch;

      expect(() => {
        store.dispatch({ type: 'TRIGGER_REENTRANT' });
      }).toThrow(/Reducers may not dispatch/);

      store.destroy();
    });

    it('a state$ subscriber may dispatch a follow-up after the reducer', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );
      let chained = false;

      const sub = store.state$.subscribe((state) => {
        if (state.count === 1 && chained === false) {
          chained = true;
          store.dispatch({ type: 'FOLLOW_UP' });
        }
      });

      store.dispatch({ type: 'INC' });
      expect(store.getState().count).toBe(11);

      sub.unsubscribe();
      store.destroy();
    });

    it('nested dispatch from an earlier subscriber must not leave later observers on a stale emission', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      const seenA: number[] = [];
      const seenB: number[] = [];
      const seenSelect: number[] = [];

      const subA = store.state$.subscribe((state) => {
        seenA.push(state.count);
        if (state.count === 1) {
          store.dispatch({ type: 'SET', payload: 99 });
        }
      });
      const subB = store.state$.subscribe((state) => {
        seenB.push(state.count);
      });
      const subSelect = store.select((state) => state.count).subscribe((count) => {
        seenSelect.push(count);
      });

      store.dispatch({ type: 'INC' });

      expect(store.getState().count).toBe(99);
      expect(seenB[seenB.length - 1]).toBe(99);
      expect(seenSelect[seenSelect.length - 1]).toBe(99);

      const last99B = seenB.lastIndexOf(99);
      const last99Select = seenSelect.lastIndexOf(99);
      expect(last99B).toBeGreaterThanOrEqual(0);
      expect(last99Select).toBeGreaterThanOrEqual(0);
      expect(seenB.slice(last99B + 1).includes(1)).toBe(false);
      expect(seenSelect.slice(last99Select + 1).includes(1)).toBe(false);

      subA.unsubscribe();
      subB.unsubscribe();
      subSelect.unsubscribe();
      store.destroy();
    });

    it('after nested subscriber dispatch, new state$/select subscribers replay getState() (not a stale buffer)', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      let midGetState: number | undefined;
      let midStateReplay: number | undefined;
      let midSelectReplay: number | undefined;

      const subA = store.state$.subscribe((state) => {
        if (state.count === 1) {
          store.dispatch({ type: 'SET', payload: 99 });
          midGetState = store.getState().count;
          store.state$.subscribe((s) => {
            midStateReplay = s.count;
          }).unsubscribe();
          store.select((s) => s.count).subscribe((n) => {
            midSelectReplay = n;
          }).unsubscribe();
        }
      });

      store.dispatch({ type: 'INC' });

      expect(midGetState).toBe(99);
      expect(midStateReplay).toBe(99);
      expect(midSelectReplay).toBe(99);
      expect(store.getState().count).toBe(99);

      subA.unsubscribe();
      store.destroy();
    });

    it('dispatch during initial state$/select replay still notifies the same subscriber', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      const seenState: number[] = [];
      const seenSelect: number[] = [];

      const subState = store.state$.subscribe((state) => {
        seenState.push(state.count);
        if (state.count === 0) {
          store.dispatch({ type: 'SET', payload: 1 });
        }
      });

      expect(store.getState().count).toBe(1);
      expect(seenState).toEqual([0, 1]);

      subState.unsubscribe();
      store.destroy();

      const storeSelect = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      const subSelect = storeSelect.select((s) => s.count).subscribe((count) => {
        seenSelect.push(count);
        if (count === 0) {
          storeSelect.dispatch({ type: 'SET', payload: 7 });
        }
      });

      expect(storeSelect.getState().count).toBe(7);
      expect(seenSelect).toEqual([0, 7]);

      subSelect.unsubscribe();
      storeSelect.destroy();
    });
  });

  describe('enhancer (B07)', () => {
    it('createStore with applyMiddleware(...mw) passes action through middleware', () => {
      const log: string[] = [];

      const loggingMiddleware: Middleware<unknown, CounterState> = () => (next) => (
        action: unknown,
      ) => {
        const typed = expectAnyAction(action);
        log.push(`mw:${typed.type}`);
        return next(typed);
      };

      const store = createStore(counterReducer, initialCounterState, applyMiddleware(loggingMiddleware));

      store.dispatch({ type: 'INC' });

      expect(log).toEqual(['mw:INC']);
      expect(store.getState().count).toBe(1);
      store.destroy();
    });

    it('a simple enhancer wraps createStore and returns a store', () => {
      let innerCreateStoreCalls = 0;

      const markingEnhancer: StoreEnhancer<CounterState, CounterAction> = (
        innerCreateStore: StoreCreator<CounterState, CounterAction>,
      ) => {
        return (reducer, initialState) => {
          innerCreateStoreCalls += 1;
          const store = innerCreateStore(reducer, initialState);
          return store;
        };
      };

      const store = createStore(
        counterReducer,
        initialCounterState,
        markingEnhancer,
      );

      expect(innerCreateStoreCalls).toBe(1);
      store.dispatch({ type: 'SET', payload: 3 });
      expect(store.getState().count).toBe(3);
      store.destroy();
    });
  });

  describe('destroy (B08, B09)', () => {
    it('destroy completes state$ and select subscriptions', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      let stateCompleted = false;
      let selectCompleted = false;

      const stateSub = store.state$.subscribe({
        next: () => {},
        complete: () => {
          stateCompleted = true;
        },
      });

      const selectSub = store.select((s) => {
        return s.count;
      }).subscribe({
        next: () => {},
        complete: () => {
          selectCompleted = true;
        },
      });

      store.destroy();

      expect(stateCompleted).toBe(true);
      expect(selectCompleted).toBe(true);

      stateSub.unsubscribe();
      selectSub.unsubscribe();
    });
  });

  describe('reducer throw and isDispatching', () => {
    it('throw in reducer resets isDispatching — next dispatch is possible', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      expect(() => {
        store.dispatch({ type: 'THROW' });
      }).toThrow('reducer boom');

      expect(store.getState()).toEqual(initialCounterState);

      store.dispatch({ type: 'INC' });
      expect(store.getState().count).toBe(1);

      store.destroy();
    });
  });

  describe('store.select + createSelector', () => {
    it('store.select(memoizedSelector) emits and memoizes combiner', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      let combinerCalls = 0;
      const selectDoubled = createSelector(
        (state: CounterState) => {
          return state.count;
        },
        (count) => {
          combinerCalls += 1;
          return count * 2;
        },
      );

      const values: number[] = [];
      const sub = store.select(selectDoubled).subscribe((value) => {
        values.push(value);
      });

      expect(values).toEqual([0]);
      expect(combinerCalls).toBe(1);

      store.dispatch({ type: 'INC' });
      expect(values).toEqual([0, 2]);
      expect(combinerCalls).toBe(2);

      store.dispatch({ type: 'SET', payload: 1 });
      expect(values).toEqual([0, 2]);
      expect(combinerCalls).toBe(2);

      sub.unsubscribe();
      store.destroy();
    });
  });

  describe('dispatch return, state$ subscription, and type guards', () => {
    it('dispatch returns the same action object', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );
      const action: CounterAction = { type: 'INC' };
      const returned = store.dispatch(action);
      expect(returned).toBe(action);
      store.destroy();
    });

    it('a new state$ subscriber immediately receives the current state', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );
      store.dispatch({ type: 'SET', payload: 7 });

      const seen: CounterState[] = [];
      const sub = store.state$.subscribe((state) => {
        seen.push(state);
      });

      expect(seen.length).toBeGreaterThanOrEqual(1);
      expect(seen[0]).toEqual({ count: 7, label: 'main' });

      sub.unsubscribe();
      store.destroy();
    });

    it('state$ — Observable without Subject API (no next/getValue)', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialCounterState,
      );

      expect(typeof store.state$.subscribe).toBe('function');
      expect(Object.hasOwn(store.state$, 'next')).toBe(false);
      expect(Object.hasOwn(store.state$, 'getValue')).toBe(false);
      expect(store.state$ instanceof Subject).toBe(false);

      store.destroy();
    });

    it('isAction — object with string type', () => {
      expect(isAction({ type: 'X' })).toBe(true);
      expect(isAction({ type: 'X', payload: 1 })).toBe(true);
      expect(isAction(null)).toBe(false);
      expect(isAction(undefined)).toBe(false);
      expect(isAction({ type: 1 })).toBe(false);
      expect(isAction('INC')).toBe(false);
      expect(isAction({})).toBe(false);
    });

    it('isMiddleware — any function', () => {
      const mw: Middleware = () => {
        return (next) => {
          return (action) => {
            const normalized = expectAnyAction(action);
            return next(normalized);
          };
        };
      };
      expect(isMiddleware(mw)).toBe(true);
      expect(isMiddleware(() => {
        return undefined;
      })).toBe(true);
      expect(isMiddleware(null)).toBe(false);
      expect(isMiddleware({})).toBe(false);
    });
  });
});
