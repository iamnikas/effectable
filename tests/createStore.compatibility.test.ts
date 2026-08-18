/**
 * Redux compatibility functional tests for createStore.
 *
 * These tests verify that the strict Redux guards don't break
 * the working system. Each test exercises the full public API
 * to prove correct behavior end-to-end.
 *
 * @module Effectable/store/createStore.compatibility.test
 */

import { applyMiddleware, createStore } from 'Effectable';
import type { Action, Middleware, MiddlewareAPI, Reducer, Store } from 'Effectable';
import { firstValueFrom, lastValueFrom, take, toArray } from 'rxjs';

interface CounterState {
  count: number;
  label: string;
}

type CounterAction =
  | { type: 'INC'; payload?: undefined }
  | { type: 'SET'; payload: number }
  | { type: 'DEC'; payload?: undefined };

const counterReducer: Reducer<CounterState, CounterAction> = (state, action) => {
  switch (action.type) {
    case 'INC':
      return { ...state, count: state.count + 1 };
    case 'DEC':
      return { ...state, count: state.count - 1 };
    case 'SET':
      return { ...state, count: action.payload };
    default:
      return state;
  }
};

const initialState: CounterState = { count: 0, label: 'test' };

describe('Redux compatibility functional tests', () => {
  describe('happy path: createStore → dispatch → getState → state$ → destroy', () => {
    it('full lifecycle works end-to-end', async () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialState,
      );

      // Collect all state$ emissions
      const statePromise = firstValueFrom(
        store.state$.pipe(take(3), toArray())
      );

      // Initial state
      expect(store.getState()).toEqual({ count: 0, label: 'test' });

      // Dispatch increments count
      store.dispatch({ type: 'INC' });
      expect(store.getState()).toEqual({ count: 1, label: 'test' });

      // Second dispatch
      store.dispatch({ type: 'INC' });
      expect(store.getState()).toEqual({ count: 2, label: 'test' });

      // state$ emitted all states
      const states = await statePromise;
      expect(states).toEqual([
        { count: 0, label: 'test' },
        { count: 1, label: 'test' },
        { count: 2, label: 'test' },
      ]);

      // destroy completes cleanly
      store.destroy();
    });

    it('multiple dispatch calls produce correct final state', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialState,
      );

      store.dispatch({ type: 'INC' });
      store.dispatch({ type: 'INC' });
      store.dispatch({ type: 'INC' });
      store.dispatch({ type: 'SET', payload: 10 });
      store.dispatch({ type: 'DEC' });

      expect(store.getState().count).toBe(9);

      store.destroy();
    });

    it('dispatch returns the action for chaining', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialState,
      );

      const action: CounterAction = { type: 'SET', payload: 42 };
      const returned = store.dispatch(action);

      expect(returned).toBe(action);
      expect(returned.type).toBe('SET');
      expect(store.getState().count).toBe(42);

      store.destroy();
    });
  });

  describe('applyMiddleware with getState() before/after next()', () => {
    it('middleware sees old state before next(), new state after', () => {
      const log: Array<{ when: string; count: number }> = [];

      const loggingMiddleware: Middleware<unknown, CounterState> = (
        api: MiddlewareAPI<unknown, CounterState>
      ) => (next) => (action: unknown) => {
        const typedAction = action as CounterAction;

        // Read state before reducer
        const stateBefore = api.getState();
        log.push({ when: `before:${typedAction.type}`, count: stateBefore.count });

        // Call reducer
        const result = next(typedAction);

        // Read state after reducer
        const stateAfter = api.getState();
        log.push({ when: `after:${typedAction.type}`, count: stateAfter.count });

        return result;
      };

      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialState,
        applyMiddleware(loggingMiddleware)
      );

      store.dispatch({ type: 'INC' });
      store.dispatch({ type: 'INC' });
      store.dispatch({ type: 'SET', payload: 10 });

      expect(log).toEqual([
        { when: 'before:INC', count: 0 },
        { when: 'after:INC', count: 1 },
        { when: 'before:INC', count: 1 },
        { when: 'after:INC', count: 2 },
        { when: 'before:SET', count: 2 },
        { when: 'after:SET', count: 10 },
      ]);

      expect(store.getState().count).toBe(10);

      store.destroy();
    });

    it('middleware chain composes correctly (multiple middleware)', () => {
      const executionOrder: string[] = [];

      const middleware1: Middleware<unknown, CounterState> = () => (next) => (action: unknown) => {
        executionOrder.push('mw1:before');
        const result = next(action as CounterAction);
        executionOrder.push('mw1:after');
        return result;
      };

      const middleware2: Middleware<unknown, CounterState> = () => (next) => (action: unknown) => {
        executionOrder.push('mw2:before');
        const result = next(action as CounterAction);
        executionOrder.push('mw2:after');
        return result;
      };

      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialState,
        applyMiddleware(middleware1, middleware2)
      );

      store.dispatch({ type: 'INC' });

      // Middleware execute in order, unwrap in reverse
      expect(executionOrder).toEqual([
        'mw1:before',
        'mw2:before',
        'mw2:after',
        'mw1:after',
      ]);

      expect(store.getState().count).toBe(1);

      store.destroy();
    });

    it('middleware api.dispatch() restarts the chain', () => {
      const actions: string[] = [];

      const interceptMiddleware: Middleware<unknown, CounterState> = (api) => (next) => (
        action: unknown
      ) => {
        const typed = action as CounterAction;
        actions.push(typed.type);

        if (typed.type === 'INC' && api.getState().count === 0) {
          // Dispatch a follow-up through the full chain
          api.dispatch({ type: 'SET', payload: 100 });
        }

        return next(typed);
      };

      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialState,
        applyMiddleware(interceptMiddleware)
      );

      store.dispatch({ type: 'INC' });

      // Should see INC, then SET (dispatched by middleware), then INC completes
      expect(actions).toEqual(['INC', 'SET']);
      expect(store.getState().count).toBe(101);

      store.destroy();
    });
  });

  describe('after destroy(): dispatch/getState throw, state$ completes', () => {
    it('dispatch throws after destroy', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialState,
      );

      store.dispatch({ type: 'INC' });
      expect(store.getState().count).toBe(1);

      store.destroy();

      expect(() => {
        store.dispatch({ type: 'INC' });
      }).toThrow(/Cannot dispatch.*after.*destroyed/);

      // State remains at last known value (though access should throw)
      expect(() => {
        store.getState();
      }).toThrow(/Cannot access state.*after.*destroyed/);
    });

    it('getState throws after destroy', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        { count: 5, label: 'test' },
      );

      expect(store.getState().count).toBe(5);

      store.destroy();

      expect(() => {
        store.getState();
      }).toThrow(/Cannot access state.*after.*destroyed/);
    });

    it('state$ is completed after destroy (no further emissions)', async () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialState,
      );

      const emissions: CounterState[] = [];
      let completed = false;

      const sub = store.state$.subscribe({
        next: (state) => emissions.push(state),
        complete: () => {
          completed = true;
        },
      });

      store.dispatch({ type: 'INC' });
      store.dispatch({ type: 'INC' });

      expect(emissions.length).toBeGreaterThanOrEqual(3); // initial + 2 dispatches

      store.destroy();

      expect(completed).toBe(true);

      sub.unsubscribe();
    });

    it('subscribe after destroy immediately completes without emissions', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialState,
      );

      store.dispatch({ type: 'SET', payload: 7 });
      store.destroy();

      const emissions: CounterState[] = [];
      let completed = false;

      const sub = store.state$.subscribe({
        next: (state) => emissions.push(state),
        complete: () => {
          completed = true;
        },
      });

      // Should complete immediately without emitting
      expect(completed).toBe(true);
      expect(emissions.length).toBe(0);

      sub.unsubscribe();
    });
  });

  describe('strict plain object validation (Redux v4 behavior)', () => {
    it('rejects Object.create(null) actions (matches Redux v4)', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialState,
      );

      // Redux v4 rejects Object.create(null) - only accepts Object.prototype
      const action = Object.create(null) as CounterAction;
      action.type = 'INC';

      expect(() => {
        store.dispatch(action);
      }).toThrow(/plain objects/);

      store.destroy();
    });

    it('rejects arrays (matches Redux v4)', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialState,
      );

      expect(() => {
        store.dispatch([{ type: 'INC' }] as unknown as CounterAction);
      }).toThrow(/plain objects/);

      store.destroy();
    });

    it('rejects class instances (matches Redux v4)', () => {
      class ActionClass {
        type = 'INC';
      }

      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialState,
      );

      expect(() => {
        store.dispatch(new ActionClass() as unknown as CounterAction);
      }).toThrow(/plain objects/);

      store.destroy();
    });

    it('accepts plain object literals', () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialState,
      );

      const action: CounterAction = { type: 'INC' };

      expect(() => {
        store.dispatch(action);
      }).not.toThrow();

      expect(store.getState().count).toBe(1);

      store.destroy();
    });
  });

  describe('undefined reducer return preserves previous state', () => {
    it('dispatch throws but getState still has last good state', () => {
      const badReducer: Reducer<CounterState, CounterAction> = (state, action) => {
        if (action.type === 'INC') {
          return { ...state, count: state.count + 1 };
        }
        if (action.type === 'SET') {
          // Bad: return undefined
          return undefined as unknown as CounterState;
        }
        return state;
      };

      const store = createStore<CounterState, CounterAction>(
        badReducer,
        initialState,
      );

      // First dispatch works
      store.dispatch({ type: 'INC' });
      expect(store.getState().count).toBe(1);

      // Second dispatch works
      store.dispatch({ type: 'INC' });
      expect(store.getState().count).toBe(2);

      // Bad dispatch throws
      expect(() => {
        store.dispatch({ type: 'SET', payload: 10 });
      }).toThrow(/Reducer returned undefined when handling action "SET"/);

      // State is still at last good value (2, not 10)
      expect(store.getState().count).toBe(2);

      // Store still works after the error
      store.dispatch({ type: 'INC' });
      expect(store.getState().count).toBe(3);

      store.destroy();
    });

    it('state$ does not emit undefined state', async () => {
      const badReducer: Reducer<CounterState, CounterAction> = (state, action) => {
        if (action.type === 'DEC') {
          return undefined as unknown as CounterState;
        }
        return counterReducer(state, action);
      };

      const store = createStore<CounterState, CounterAction>(
        badReducer,
        initialState,
      );

      const emissions: CounterState[] = [];
      const sub = store.state$.subscribe((state) => {
        emissions.push(state);
      });

      store.dispatch({ type: 'INC' });
      store.dispatch({ type: 'INC' });

      expect(() => {
        store.dispatch({ type: 'DEC' });
      }).toThrow(/Reducer returned undefined/);

      store.dispatch({ type: 'INC' });

      // Emissions: initial(0), INC(1), INC(2), INC(3)
      // DEC never emitted because reducer threw
      expect(emissions.length).toBe(4);
      expect(emissions.map((s) => s.count)).toEqual([0, 1, 2, 3]);

      sub.unsubscribe();
      store.destroy();
    });

    it('undefined error resets isDispatching flag for next dispatch', () => {
      const badReducer: Reducer<CounterState, CounterAction> = (state, action) => {
        if (action.type === 'SET') {
          return undefined as unknown as CounterState;
        }
        return counterReducer(state, action);
      };

      const store = createStore<CounterState, CounterAction>(
        badReducer,
        initialState,
      );

      expect(() => {
        store.dispatch({ type: 'SET', payload: 5 });
      }).toThrow(/Reducer returned undefined/);

      // Next dispatch should work (isDispatching was reset)
      expect(() => {
        store.dispatch({ type: 'INC' });
      }).not.toThrow();

      expect(store.getState().count).toBe(1);

      store.destroy();
    });
  });

  describe('select() still works correctly', () => {
    it('select() emits selector results with distinctUntilChanged', async () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialState,
      );

      const countPromise = firstValueFrom(
        store.select((state) => state.count).pipe(take(3), toArray())
      );

      store.dispatch({ type: 'INC' });
      store.dispatch({ type: 'INC' });

      const counts = await countPromise;
      expect(counts).toEqual([0, 1, 2]);

      store.destroy();
    });

    it('select() does not emit unchanged values', async () => {
      const store = createStore<CounterState, CounterAction>(
        counterReducer,
        initialState,
      );

      const labelPromise = firstValueFrom(
        store.select((state) => state.label).pipe(take(1), toArray())
      );

      store.dispatch({ type: 'INC' });
      store.dispatch({ type: 'INC' });
      store.dispatch({ type: 'SET', payload: 100 });

      const labels = await labelPromise;
      // Label never changed, so only initial emission
      expect(labels).toEqual(['test']);

      store.destroy();
    });
  });
});
