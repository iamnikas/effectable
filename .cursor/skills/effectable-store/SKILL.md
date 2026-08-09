---
name: effectable-store
description: Rules for using the shared store from effectable/store, middleware, dispatch pipelines, Action/State typing, Component super/h conventions, and GraphRuntime vs HandleRegistry refs. Use when changing store setup, middleware, reducers/selectors, or Effectable Component/ref examples.
---

# Effectable Store

Rules for working with the shared store from `effectable/store`, plus Component / ref conventions that keep store and runtime usage consistent.

## When to apply

- Changing application store setup, middleware, root reducer, root store, or the dispatch pipeline.
- Changing `RootState` / `RootAction` contracts, actions, reducers, or selectors.
- Wiring side effects and async flows through middleware.
- Updating examples or docs around Effectable store/runtime interaction, `Component`, or imperative refs.

## Contract sources

- Canonical API and examples: `src/store/README.md`
- Import store and types from `effectable` or `effectable/store`
- Connect usage: `.cursor/skills/effectable-connect/SKILL.md` and `src/connect/README.md`

## Basic root-store creation pattern

Use this sequence:

1. Create the base store: `createStore(rootReducer, rootInitialState)`.
2. Keep `rawDispatch`.
3. Prepare `api` (`getState`, dispatch stub).
4. Wrap dispatch with `applyMiddleware(api, rawDispatch, ...middlewares)`.
5. Assign the final dispatch:
   - `api.dispatch = dispatch`
   - `store.dispatch = dispatch`

This keeps the middleware chain correct and makes `next(action)` / `api.dispatch(action)` behave consistently.

## Middleware rules

- Signature: `(api) => (next) => (action) => result`.
- Branch on actions with `switch (action.type)`.
- In `default`, always return `next(action)`.
- Put side effects and async work in middleware, not in reducers.
- `next(action)` forwards along the current chain.
- `api.dispatch(action)` restarts the action from the beginning of the middleware chain.

## Async flows

- Express async work as plain object actions + middleware.
- For request flows, use explicit stages (`*_START`, `*_SUCCESS`, `*_ERROR`) when the slice already follows that style.
- On errors, dispatch a dedicated action with an error payload; do not swallow exceptions inside reducers.

## Suggested application store layout

- Organize by entity/slice (`projects`, `strategies`, sessions, etc.).
- Keep actions/reducer/middleware/types/selectors next to each other, with `index.ts` for public re-exports.
- Root layer (`root.reducer.ts`, `root.types.ts`, `index.ts`) assembles slices and creates the store.
- Cross-slice orchestration belongs in middleware / connector services, not in reducers mutating another slice.

## Typing and safety

- Explicitly type `State`, `Action`, `Dispatch`, `MiddlewareAPI`.
- Do not suppress the type system (`any`, unsafe casts) instead of checks.
- For unknown actions, validate required fields first, then handle.

## Component / `h` conventions (examples and app code)

- For `Component` subclasses call `super(props)` with no second argument.
- **Forbidden** `super(props, {})`: an empty object as the second argument is meaningless — only `super(props)`.
- For `h()` with empty props (`Record<string, never>`) write `h(Ctor)` without a second argument.
- **Forbidden** `h(Ctor, {})`. If you need ref/children with empty props — `h(Ctor, undefined, ref)` / `h(Ctor, undefined, children)`, not `h(Ctor, {}, …)`.
- Set initial state after `super(props)` via explicit `this.state = { ... }`.
- **Forbidden** to show `super(props, initialState)` in examples or docs (including as an “alternate” style). Canonical pattern is the section below.
- In `ref` examples, do not present ordinary component methods as lifecycle hooks.
- Imperative calls through `ref` should be ordinary public methods, command handlers, or admin actions — not pseudo-hooks like `onSomething` unless they are real `Component` lifecycle methods. Use **`@UseRef()`** and **`@UseImperativeHandle()`** from `effectable/component` (also re-exported from `effectable`); see `docs/ARCHITECTURE.md` and the “Imperative `ref`” example below. For HandleRegistry registration use the aliases `HandleRegistryUseRef` / `HandleRegistryUseImperativeHandle` from `effectable` (see comment in `src/index.ts`).
- Prefer an explicit `null` check before using `ref.current`.

## Two ref contexts (do not mix without intent)

1. **GraphRuntime / component tree** — decorators **`@UseRef`**, **`@UseImperativeHandle`** from `effectable/component` (also from `effectable`): ref objects in the UI/service node graph.
2. **HandleRegistry / runtime bus** (command/query, shared handle registry) — **`forwardRef`**, **`HandleRegistryUseRef`**, **`HandleRegistryUseImperativeHandle`** from `effectable` (see `src/index.ts`), plus **`handleRegistry.autoRegister(instance)`** after mount. Different contract — do not substitute for component refs.

## Connecting to the store

- Use **`connect(store, mapStateToProps?, mapDispatchToProps?)(Component)`** at the composition root — see `.cursor/skills/effectable-connect/SKILL.md` and `src/connect/README.md`.
- Do not proliferate `createConnectedXxx(store)` factories that each wrap the same `store.dispatch` body.
- **Strictly forbidden** to introduce and pass “constructor values” (`*Ctor`, `*Connected`, `engineCtor`) as part of a domain API:
  - do not store Ctors in store/state/props,
  - do not export Ctors from services as the public integration surface,
  - do not pass Ctors between services as dependencies.

## No duplicate HandleRegistry wrappers

- Do not manually assemble the same object that **`HandleRegistryUseImperativeHandle`** / **`HandleRegistryUseRef`** already provide together with **`autoRegister`** / `register`, via public “build the handle yourself” methods on the service. Registration follows the HandleRegistry contract.

## Correct examples

### Root store with middleware

```typescript
import {
  applyMiddleware,
  createStore,
} from 'effectable/store';

const store = createStore(rootReducer, rootInitialState);
const rawDispatch = store.dispatch;

const api = {
  getState: store.getState,
  dispatch: (_action: RootAction) => {
    throw new Error('Dispatch is not ready yet');
  },
};

const dispatch = applyMiddleware(
  api,
  rawDispatch,
  loggerMiddleware,
  projectsMiddleware,
);

api.dispatch = dispatch;
store.dispatch = dispatch;
```

### Middleware with `switch (action.type)`

```typescript
const graphSessionsMiddleware: Middleware<RootState, RootAction> =
  (api) => (next) => (action) => {
    switch (action.type) {
      case 'GRAPH_SESSION_START': {
        api.dispatch({
          type: 'GRAPH_SESSION_STATUS_CHANGED',
          payload: {
            id: action.payload.id,
            status: 'starting',
          },
        });

        return next(action);
      }

      default: {
        return next(action);
      }
    }
  };
```

### `Component`: only `super(props)` and explicit `this.state`

```typescript
class TickBuffer extends Component<{ size: number }, { symbol: string }> {
  constructor(props: { symbol: string }) {
    super(props);
    this.state = {
      size: 0,
    };
  }
}
```

### Imperative `ref`: ordinary public method, not a lifecycle hook

```typescript
class Child extends Component {
  @UseImperativeHandle()
  public async reset(): Promise<void> {
    await resetInternalState();
  }
}

class Parent extends Component {
  @UseRef() private childRef!: RefObject<Child>;

  public async resetChild(): Promise<void> {
    const child = this.childRef.current;

    if (!child) {
      return;
    }

    await child.reset();
  }
}
```

## Checklist before finishing

- [ ] Component-refs and HandleRegistry-refs are separated; imports are not mixed by accident.
- [ ] Store wiring uses `connect(store, ...)` without redundant `createConnected*` factories that duplicate `dispatch`.
- [ ] Imports come from `effectable/store` (or a thin local re-export of it).
- [ ] Dispatch chain is built with `applyMiddleware`, and `api.dispatch` is assigned after wrapping.
- [ ] Middleware uses `switch (action.type)` and `default -> next(action)`.
- [ ] Async logic lives in middleware; reducers stay pure.
- [ ] Slice/root `index.ts` exports keep a stable public API.
- [ ] `Component` examples use `super(props)` with no second argument (including no `super(props, {})`).
- [ ] Empty-props `h()` examples use `h(Ctor)`, not `h(Ctor, {})`.
- [ ] `ref` examples do not disguise ordinary methods as lifecycle hooks.
