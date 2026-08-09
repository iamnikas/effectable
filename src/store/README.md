# Redux-RxJS Store Core Library

A Redux-like store library with full RxJS support.
It has no application-specific dependencies and can be used in any project.

## File structure

```text
Effectable/store/
├── index.ts          # Main export of all modules
├── types.ts          # TypeScript types and interfaces
├── createStore.ts    # Store creation function
├── middleware.ts     # Middleware system
├── selector.ts       # Memoized selectors
└── README.md         # This file
```

## Main modules

### createStore

Creates a Redux Store with RxJS support:

```typescript
import { createStore, applyMiddleware } from 'Effectable/store';

const store = createStore(rootReducer, initialState);
const rawDispatch = store.dispatch;
const api = {
  getState: store.getState,
  dispatch: null as unknown as typeof rawDispatch,
};
const dispatch = applyMiddleware(api, rawDispatch, loggingMiddleware);
api.dispatch = dispatch;
store.dispatch = dispatch;
```

**Returned Store object:**

- `dispatch(action)` - dispatch an action
- `getState()` - get the current state
- `state$` - state Observable (RxJS)
- `select(selector)` - apply a selector with distinctUntilChanged
- `destroy()` - shut down the Store

### applyMiddleware

Applies middleware to the Store:

```typescript
import { applyMiddleware } from 'Effectable/store';

const dispatch = applyMiddleware(
  api,
  rawDispatch,
  loggingMiddleware,
  analyticsMiddleware
);
```

**Middleware signature:**

```typescript
const middleware = (api) => (next) => (action) => {
  // Logic before reducer
  const result = next(action);
  // Logic after reducer
  return result;
};
```

### Recommended Redux-style middleware pattern

For middleware with side-effects, use a single pattern with `switch(action.type)` and a required `default: return next(action)`:

```typescript
import type { Dispatch, MiddlewareAPI, AnyAction } from 'Effectable/store';

export default function exampleMiddleware(api: MiddlewareAPI<Dispatch, unknown>): (next: Dispatch) => (action: unknown | Promise<unknown>) => unknown | Promise<unknown> {
  return (next: Dispatch) => (action: unknown | Promise<unknown>) => {
    const a = action as AnyAction;

    switch (a.type) {
      case 'FETCH_USERS_REQUEST': {
        next({ type: 'FETCH_USERS_START' });
        void fetch('/api/users')
          .then(() => {
            api.dispatch({ type: 'FETCH_USERS_REQUEST_FINISHED' });
          });
        return next(action as AnyAction);
      }

      default: {
        return next(action as AnyAction);
      }
    }
  };
}
```

Note: in middleware, `action` may be a plain object or async (e.g. a `Promise`) if your pipeline allows it.

Difference between calls:

- `next(action)` — forwards the action down the current middleware chain to the next middleware or the reducer.
- `api.dispatch(action)` — starts the action again from the beginning of the entire middleware chain.

Recommendation: handle actions inside middleware with `switch(action.type)`, and in the `default` branch always return `next(action)`.

### createSelector

Creates memoized selectors:

```typescript
import { createSelector } from 'Effectable/store';

const selectUsers = (state) => state.users;
const selectFilter = (state) => state.filter;

const selectFilteredUsers = createSelector(
  [selectUsers, selectFilter],
  (users, filter) => users.filter(u => u.name.includes(filter))
);
```

**Benefits:**

- Result memoization
- Recomputation only when dependencies change
- `resetMemoization()` and `recomputations()` methods for debugging

### Types

Full set of TypeScript types:

```typescript
import {
  Store,
  Action,
  Reducer,
  Dispatch,
  Middleware,
  Selector,
  MemoizedSelector
} from 'Effectable/store';
```

## Differences from Redux

### 1. RxJS Integration

**state$ Observable:**

```typescript
store.state$.subscribe(state => {
  console.log('State changed:', state);
});
```

**select() method:**

```typescript
const currentPath$ = store.select(state => state.navigation.currentPath);
currentPath$.subscribe(path => console.log('Path:', path));
```

### 2. RxJS in Middleware

Middleware has access to the `state$` Observable:

```typescript
const reactiveMiddleware = (store) => (next) => {
  // Subscribe to state changes
  store.state$.pipe(
    map(state => state.navigation.currentPath),
    distinctUntilChanged()
  ).subscribe(path => {
    console.log('Path changed:', path);
  });

  return (action) => next(action);
};
```

### 3. No subscribe method

Redux has `store.subscribe()`; here use `store.state$`:

```typescript
// Redux
store.subscribe(() => console.log(store.getState()));

// Redux-RxJS Store
store.state$.subscribe(state => console.log(state));
```

## Usage

### Basic example

```typescript
import {
  createStore,
  applyMiddleware,
  createSelector
} from 'Effectable/store';

// 1. Define types
interface AppState {
  count: number;
}

interface IncrementAction {
  type: 'INCREMENT';
  payload: number;
}

type AppAction = IncrementAction;

// 2. Create reducer
const reducer = (state: AppState, action: AppAction): AppState => {
  switch (action.type) {
    case 'INCREMENT':
      return { ...state, count: state.count + action.payload };
    default:
      return state;
  }
};

// 3. Create Store
const store = createStore(reducer, { count: 0 });

// 4. Create selectors
const selectCount = createSelector(
  [(state: AppState) => state.count],
  (count) => count
);

// 5. Subscribe
store.select(selectCount).subscribe(count => {
  console.log('Count:', count);
});

// 6. Dispatch actions
store.dispatch({ type: 'INCREMENT', payload: 1 });
```

### With Middleware

```typescript
import { createStore, applyMiddleware } from 'Effectable/store';

const loggingMiddleware = (api) => (next) => (action) => {
  console.log('Action:', action.type);
  const result = next(action);
  console.log('New state:', api.getState());
  return result;
};

const store = createStore(
  reducer,
  initialState,
  applyMiddleware(loggingMiddleware)
);
```

### Async Middleware

```typescript
const asyncMiddleware = (api) => (next) => async (action) => {
  if (action.type === 'FETCH_DATA') {
    api.dispatch({ type: 'LOADING_START' });

    try {
      const data = await fetchData();
      api.dispatch({ type: 'DATA_LOADED', payload: data });
    } catch (error) {
      api.dispatch({ type: 'ERROR', payload: error });
    }

    return action;
  }

  return next(action);
};
```

Async logic in the library is recommended via plain object actions and middleware.
A separate `thunk` helper is not part of the public `Effectable/store` API.

## API Reference

### Store

```typescript
interface Store<S, A extends Action> {
  dispatch(action: A): A | Promise<A>;
  getState(): S;
  state$: Observable<S>;
  select<T>(selectorFn: Selector<S, T>): Observable<T>;
  destroy(): void;
}
```

### Middleware

```typescript
type Middleware<S, A extends Action> = (
  api: MiddlewareAPI<Dispatch<A>, S>
) => (
  next: Dispatch<A>
) => (
  action: unknown
) => unknown;

interface MiddlewareAPI<D extends Dispatch = Dispatch, S = unknown> {
  dispatch: D;
  getState: () => S;
  state$: Observable<S>;
}
```

### Selector

```typescript
type Selector<S, R> = (state: S) => R;

interface MemoizedSelector<S, R> extends Selector<S, R> {
  resetMemoization(): void;
  recomputations(): number;
}
```

## Compatibility with Redux

The library is highly compatible with the Redux v4 API:

✅ `createStore(reducer, initialState, enhancer)`
✅ `applyMiddleware(...middlewares)`
✅ `store.dispatch(action)`
✅ `store.getState()`
✅ Middleware signature `(store) => (next) => (action) => result`
✅ Reducer pattern `(state, action) => newState`

❌ `store.subscribe()` - use `store.state$`
❌ `combineReducers()` - create manually
❌ Redux DevTools - not supported yet

## Performance

### Selector memoization

Selectors recompute only when dependencies change:

```typescript
const selector = createSelector(
  [(state) => state.items],
  (items) => items.filter(item => item.active)
);

// Call 1: recompute (recomputations: 1)
const result1 = selector(state1);

// Call 2: return cache if state1.items === state2.items
const result2 = selector(state2);

// Debugging
console.log(selector.recomputations()); // 1 or 2
```

### distinctUntilChanged

The `select()` method automatically applies `distinctUntilChanged`:

```typescript
// Subscription will not fire if currentPath did not change
store.select(state => state.navigation.currentPath)
  .subscribe(path => console.log('Path:', path));
```

## Testing

```typescript
import { createStore } from 'Effectable/store';

describe('Counter Store', () => {
  it('should increment counter', () => {
    const store = createStore(reducer, { count: 0 });

    store.dispatch({ type: 'INCREMENT', payload: 1 });

    expect(store.getState().count).toBe(1);
  });

  it('should emit state changes', (done) => {
    const store = createStore(reducer, { count: 0 });

    store.state$.pipe(skip(1)).subscribe(state => {
      expect(state.count).toBe(1);
      done();
    });

    store.dispatch({ type: 'INCREMENT', payload: 1 });
  });
});
```

## Best Practices

### 1. Typing

Always type State and Actions:

```typescript
interface State {
  count: number;
}

type Action =
  | { type: 'INCREMENT'; payload: number }
  | { type: 'DECREMENT'; payload: number };

const store = createStore<State, Action>(reducer, initialState);
```

### 2. Immutability

Always return a new object from the reducer:

```typescript
// Good
return { ...state, count: state.count + 1 };

// Bad
state.count++;
return state;
```

### 3. Selector composition

Reuse selectors:

```typescript
const selectUsers = (state) => state.users;
const selectFilter = (state) => state.filter;

const selectFilteredUsers = createSelector(
  [selectUsers, selectFilter],
  (users, filter) => users.filter(u => u.name.includes(filter))
);

const selectActiveUsers = createSelector(
  [selectFilteredUsers],
  (users) => users.filter(u => u.active)
);
```

### 4. Cleanup

Do not forget to call `destroy()`:

```typescript
const store = createStore(reducer, initialState);

// On component unmount
componentWillUnmount() {
  store.destroy();
}
```

## Migrating from Redux

```typescript
// Before (Redux)
import { createStore, applyMiddleware } from 'redux';

const store = createStore(reducer, initialState, applyMiddleware(logger));
store.subscribe(() => console.log(store.getState()));

// After (Redux-RxJS Store)
import { createStore, applyMiddleware } from 'Effectable/store';

const store = createStore(reducer, initialState, applyMiddleware(logger));
store.state$.subscribe(state => console.log(state));
```

## License

MIT — see the package root `LICENSE`.
