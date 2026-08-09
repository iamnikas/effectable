/**
 * Unit tests for redux-style middleware in Effectable Store.
 */

import { applyMiddleware, compose, createStore } from 'Effectable';
import type { AnyAction, Middleware, StoreEnhancer } from 'Effectable';

interface TestState {
  events: string[];
}

/**
 * Reducer for the test store: accumulates `action.type` in state.events.
 *
 * @param {TestState} state - current state
 * @param {AnyAction} action - input action
 * @returns {TestState} new state
 */
function testReducer (state: TestState, action: AnyAction): TestState {
  return {
    events: [...state.events, action.type],
  };
}

describe('Effectable store middleware', () => {
  test('passes action through next along the whole middleware chain', () => {
    const calls: string[] = [];

    const firstMiddleware: Middleware<unknown, TestState> = (_api) => (next) => (action: unknown) => {
      if (typeof action !== 'object' || action === null || !('type' in action)) {
        throw new Error('Expected action with type');
      }

      const currentAction = action as AnyAction;
      calls.push(`first:before:${currentAction.type}`);
      const result = next(currentAction);
      calls.push(`first:after:${currentAction.type}`);
      return result;
    };

    const secondMiddleware: Middleware<unknown, TestState> = (_api) => (next) => (action: unknown) => {
      if (typeof action !== 'object' || action === null || !('type' in action)) {
        throw new Error('Expected action with type');
      }

      const currentAction = action as AnyAction;
      calls.push(`second:before:${currentAction.type}`);
      const result = next(currentAction);
      calls.push(`second:after:${currentAction.type}`);
      return result;
    };

    const store = createStore(testReducer, { events: [] });
    const rawDispatch = store.dispatch;

    let dispatchRef: typeof rawDispatch | null = null;
    const api = {
      getState: store.getState,
      dispatch: (action: AnyAction) => {
        if (dispatchRef === null) {
          throw new Error('Dispatch is not wired yet');
        }

        return dispatchRef(action);
      },
    };

    const maybeDispatch = applyMiddleware(api, rawDispatch, firstMiddleware, secondMiddleware);
    if (typeof maybeDispatch !== 'function') {
      throw new Error('applyMiddleware must return dispatch function');
    }

    // applyMiddleware returns the same dispatch type as rawDispatch.
    const dispatch = maybeDispatch as typeof rawDispatch;
    dispatchRef = dispatch;

    dispatch({ type: 'ROOT_ACTION' });

    expect(calls).toEqual([
      'first:before:ROOT_ACTION',
      'second:before:ROOT_ACTION',
      'second:after:ROOT_ACTION',
      'first:after:ROOT_ACTION',
    ]);
    expect(store.getState().events).toEqual(['ROOT_ACTION']);
  });

  test('api.dispatch starts the action from the beginning of the middleware chain', () => {
    const calls: string[] = [];

    const tracingMiddleware: Middleware<unknown, TestState> = (api) => (next) => (action: unknown) => {
      if (typeof action !== 'object' || action === null || !('type' in action)) {
        throw new Error('Expected action with type');
      }

      const currentAction = action as AnyAction;
      calls.push(`trace:${currentAction.type}`);

      if (currentAction.type === 'OUTER_ACTION') {
        api.dispatch({ type: 'INNER_ACTION' });
      }

      return next(currentAction);
    };

    const store = createStore(testReducer, { events: [] });
    const rawDispatch = store.dispatch;

    let dispatchRef: typeof rawDispatch | null = null;
    const api = {
      getState: store.getState,
      dispatch: (action: AnyAction) => {
        if (dispatchRef === null) {
          throw new Error('Dispatch is not wired yet');
        }

        return dispatchRef(action);
      },
    };

    const maybeDispatch = applyMiddleware(api, rawDispatch, tracingMiddleware);
    if (typeof maybeDispatch !== 'function') {
      throw new Error('applyMiddleware must return dispatch function');
    }

    const dispatch = maybeDispatch as typeof rawDispatch;
    dispatchRef = dispatch;

    dispatch({ type: 'OUTER_ACTION' });

    expect(calls).toEqual([
      'trace:OUTER_ACTION',
      'trace:INNER_ACTION',
    ]);
    expect(store.getState().events).toEqual([
      'INNER_ACTION',
      'OUTER_ACTION',
    ]);
  });

  it('D07: enhancer-mode — applyMiddleware as the third createStore argument', () => {
    const seen: string[] = [];

    const loggingMiddleware: Middleware<unknown, TestState> = () => (next) => (action: unknown) => {
      if (typeof action !== 'object' || action === null || !('type' in action)) {
        throw new Error('Expected action with type');
      }

      const currentAction = action as AnyAction;
      seen.push(`mw:${currentAction.type}`);
      return next(currentAction);
    };

    const maybeEnhancer = applyMiddleware(loggingMiddleware);
    if (typeof maybeEnhancer !== 'function') {
      throw new Error('applyMiddleware enhancer-mode must return StoreEnhancer function');
    }

    const enhancer = maybeEnhancer as StoreEnhancer<TestState, AnyAction>;
    const store = createStore(testReducer, { events: [] }, enhancer);

    store.dispatch({ type: 'ENHANCER_ACTION' });

    expect(seen).toEqual(['mw:ENHANCER_ACTION']);
    expect(store.getState().events).toEqual(['ENHANCER_ACTION']);
  });
});

describe('D03–D04 compose', () => {
  it('D03–D04: compose with no functions — identity; one — same reference; several — right-to-left composition', () => {
    const identity = compose<number>();
    expect(identity(7)).toBe(7);

    const addOne = (value: number): number => value + 1;
    expect(compose(addOne)).toBe(addOne);
    expect(compose(addOne)(2)).toBe(3);

    const double = (value: number): number => value * 2;
    const composed = compose(addOne, double);
    expect(composed(5)).toBe(11);
  });
});

describe('D05 middleware throw and state integrity', () => {
  it('D05: throw before next() — error is rethrown, reducer does not change state', () => {
    const throwingBeforeNext: Middleware<unknown, TestState> = () => (_next) => (_action: unknown) => {
      throw new Error('middleware fail before next');
    };

    const maybeEnhancer = applyMiddleware(throwingBeforeNext);
    if (typeof maybeEnhancer !== 'function') {
      throw new Error('applyMiddleware enhancer-mode must return StoreEnhancer function');
    }

    const enhancer = maybeEnhancer as StoreEnhancer<TestState, AnyAction>;
    const store = createStore(testReducer, { events: [] }, enhancer);

    expect(() => {
      store.dispatch({ type: 'SHOULD_NOT_APPLY' });
    }).toThrow('middleware fail before next');

    expect(store.getState().events).toEqual([]);
  });

  it('D05: throw after next() — reducer already applied action, getState updated, error still rethrown', () => {
    const throwingAfterNext: Middleware<unknown, TestState> = () => (next) => (action: unknown) => {
      if (typeof action !== 'object' || action === null || !('type' in action)) {
        throw new Error('Expected action with type');
      }

      const currentAction = action as AnyAction;
      next(currentAction);
      throw new Error('middleware fail after next');
    };

    const maybeEnhancer = applyMiddleware(throwingAfterNext);
    if (typeof maybeEnhancer !== 'function') {
      throw new Error('applyMiddleware enhancer-mode must return StoreEnhancer function');
    }

    const enhancer = maybeEnhancer as StoreEnhancer<TestState, AnyAction>;
    const store = createStore(testReducer, { events: [] }, enhancer);

    expect(() => {
      store.dispatch({ type: 'APPLIED_BEFORE_THROW' });
    }).toThrow('middleware fail after next');

    expect(store.getState().events).toEqual(['APPLIED_BEFORE_THROW']);
  });
});

describe('MW-08 / MW-09 middleware async and swallow', () => {
  it('MW-08: async middleware returns a Promise via dispatch', async () => {
    const asyncMiddleware: Middleware<unknown, TestState> = () => (next) => (action: unknown) => {
      if (typeof action !== 'object' || action === null || !('type' in action)) {
        throw new Error('Expected action with type');
      }

      const currentAction = action as AnyAction;
      return Promise.resolve().then(() => {
        return next(currentAction);
      });
    };

    const maybeEnhancer = applyMiddleware(asyncMiddleware);
    if (typeof maybeEnhancer !== 'function') {
      throw new Error('applyMiddleware enhancer-mode must return StoreEnhancer function');
    }

    const enhancer = maybeEnhancer as StoreEnhancer<TestState, AnyAction>;
    const store = createStore(testReducer, { events: [] }, enhancer);

    const result = store.dispatch({ type: 'ASYNC_OK' });
    expect(result).toBeInstanceOf(Promise);

    await result;

    expect(store.getState().events).toEqual(['ASYNC_OK']);
    store.destroy();
  });

  it('MW-09: middleware without next — reducer is not called', () => {
    const swallowing: Middleware<unknown, TestState> = () => (_next) => (_action: unknown) => {
      return undefined;
    };

    const maybeEnhancer = applyMiddleware(swallowing);
    if (typeof maybeEnhancer !== 'function') {
      throw new Error('applyMiddleware enhancer-mode must return StoreEnhancer function');
    }

    const enhancer = maybeEnhancer as StoreEnhancer<TestState, AnyAction>;
    const store = createStore(testReducer, { events: [] }, enhancer);

    store.dispatch({ type: 'SWALLOWED' });

    expect(store.getState().events).toEqual([]);
    store.destroy();
  });

  it('MW-10: default-export middleware `{ default: fn }` is unwrapped', () => {
    const logging: Middleware<unknown, TestState> = () => (next) => (action: unknown) => {
      if (typeof action !== 'object' || action === null || !('type' in action)) {
        throw new Error('Expected action with type');
      }
      const currentAction = action as AnyAction;
      return next(currentAction);
    };
    const moduleNs = { default: logging };

    const maybeEnhancer = applyMiddleware(moduleNs as unknown as Middleware);
    if (typeof maybeEnhancer !== 'function') {
      throw new Error('applyMiddleware enhancer-mode must return StoreEnhancer function');
    }

    const enhancer = maybeEnhancer as StoreEnhancer<TestState, AnyAction>;
    const store = createStore(testReducer, { events: [] }, enhancer);
    store.dispatch({ type: 'FROM_DEFAULT_EXPORT' });
    expect(store.getState().events).toEqual(['FROM_DEFAULT_EXPORT']);
    store.destroy();
  });
});

