# Effectable Connect

HOC module **`connect`**: connects a class component to the store via optional **`mapStateToProps`** and **`mapDispatchToProps`**, implemented as a **class-based wrapper** over the original class.

Two forms are supported:

- `connect(store, mapState, mapDispatch)(Ctor)` — root connected component that publishes the store into the subtree.
- `connect(mapState, mapDispatch)(Ctor)` — child connected component that receives the store from context of the nearest connected ancestor.

The result is a subclass constructor for `h(ConnectedCtor, props)` and GraphRuntime. Lifecycle — `onMount` / `onUpdate` / `onUnmount`.

## Structure

```text
Effectable/connect/
├── index.ts   # connect, types
├── types.ts   # MapStateToProps, MapDispatchToProps, MapDispatchToPropsDispatchOnly, ConnectableInstance, …
├── connect.ts # connect(store, msp?, mdp?)(Ctor)
├── connect.spec.ts
└── README.md
```

## Types

### MapStateToProps&lt;S, P, R&gt;

`(state: S, props: P) => R`. The result is merged into `instance.props`. If **not provided**, a subscription to `store.select` is **not created**.

The second argument `props` is **parent props** (from `h(ConnectedCtor, props)`). They can be used inside the selector (including for pass-through: explicitly return the needed ownProp so it appears in `this.props` under strict mode — see below).

### MapDispatchToProps

- **Full function** `(dispatch, props) => object` — when both arguments are needed in the body (in JS the function has `length >= 2`).
- **Short form** `(dispatch) => object` — only callbacks from `dispatch`; inside `connect` it is called as `fn(dispatch)` **without** a `(d) => mapXxx(d)` wrapper outside. Pass `mapXxxDispatchToProps` itself.
- **Action creators object** `{ propName: (...args) => Action }` — each method is bound as `dispatch(actionCreator(...args))`.

Stable dispatch-props are computed **once** at the start of `onMount`.

**Important:** if the second `props` parameter is needed in mapDispatch, declare **two parameters without a default value** on the second — otherwise `function.length` may be 1 and `props` will not be passed.

### ConnectableInstance / ConnectableConstructor

Instance shape and strict constructor for documentation.

### ConnectableHocTarget

Widened constructor for the HOC argument under `strictFunctionTypes`.

### ConnectOptions

- **`ownPropsModeMerge?: boolean`** — enables the legacy `merge` mode for building public `this.props`.
  - **`false` or unset (default = strict):** parent props do NOT leak into `this.props` automatically. `this.props` receives only what `mapStateToProps`/`mapDispatchToProps` explicitly returned. To forward a parent prop — return it explicitly from `mapStateToProps(state, props)` (pass-through). This is the runtime-boundary contract `GraphRuntime` ↔ store: the component explicitly declares what it reads.
  - **`true` (legacy, transitional = merge):** final props are `props → dispatchProps → stateProps`, i.e. parent props are forwarded automatically. Set only deliberately for components not yet migrated to explicit mappers.

```typescript
// strict (default): option not needed. adapterRegistry from h(...) will not appear in props without explicit pass-through
const MarketService = connect(
  (state: RootState, props: { adapterRegistry: AdapterRegistry }) => ({
    adapterRegistry: props.adapterRegistry, // explicit pass-through
  }),
  mapMarketDispatchToProps
)(MarketDataServiceComponent);

// legacy merge: props are forwarded automatically (only where intentionally needed)
const Legacy = connect(undefined, mapDispatch, { ownPropsModeMerge: true })(Cmp);
```

## API: connect

```typescript
const ConnectedAppRoot = connect(
  rootStore,
  (state: RootState) => ({ user: state.user }),
  (dispatch) => ({ logout: () => dispatch({ type: 'LOGOUT' }) })
)(AppRoot);

// Short mapDispatch form — pass the mapper itself (one dispatch argument):
const ConnectedFeeds = connect(undefined, mapFeedsDispatchToProps)(FeedsConnector);

// Or an action creators object (values are functions returning an action):
const ConnectedFeedsWithCreators = connect(undefined, {
  dispatchFeedsTicks: (payload) => ({ type: FEEDS_TICKS_UPDATED, payload }),
})(FeedsConnector);
```

## Connected class lifecycle

1. `new ConnectedCtor(props)`.
2. **`applyToScope` (before first `compose()`):** GraphRuntime publishes the store into the subtree
   and the HOC **synchronously** applies dispatch + current `mapStateToProps` into `this.props`.
   In strict mode this also strips parent own-props so the first `compose()` cannot branch on
   leaked secrets / unmapped fields (and cannot PLACE the wrong child for one generation).
3. HOC `onMount()`: merge dispatch → subscribe to state if needed → `super.onMount`.
4. **Post-mount kick-off:** if `mapStateToProps` **or** `mapDispatchToProps` is set, after mount completes
   the HOC schedules **one** deferred `setState({})` via `queueMicrotask`. This yields exactly one
   `onUpdate` after mount even on a cold start (store already populated, no new emits) — without
   `setTimeout`/`setState({})` in the consumer. Guards: not after unmount; do not duplicate if
   `onUpdate` was already delivered (pending flush / store emit); exactly once per mount.
5. Store emits (if `mapStateToProps` is present) → merge → `setState` → `onUpdate`.
6. `onUnmount` — unsubscribe and `super.onUnmount`.

### Remount and class-field lifecycle

- **Same-instance remount** (GraphRuntime reuses the connected instance): mount flags and generation reset so store wiring and the post-mount kick-off run again; stale async `onMount` from a prior generation is ignored; stale `__connectStateProps` are cleared and the context store is re-resolved when needed.
- **Class-field hooks:** declaring `onMount` / `onUnmount` as class fields (own instance properties) does **not** skip connect subscribe / unsubscribe — the HOC still wraps lifecycle through its wiring path.
- **Subscribe failures:** errors from `mapStateToProps` subscription fail the mount (tear-down guards apply).

### Migration note (post-mount kick-off)

- **Behavior:** every connected component with `mapStateToProps` and/or `mapDispatchToProps` gets one extra
  `onUpdate` after a successful mount (via microtask). Components with neither mapper are unaffected.
- **API compatibility:** signatures of `connect` / `Component` / `GraphRuntime.mount` did not change.
- **Consumers:** `onUpdate` must be idempotent on a repeated pass (guards on state/props).
  An empty `setTimeout(() => this.setState({}), 0)` after `onMount` / inside `onUpdate` is no longer needed.
- A store emit during **synchronous** `super.onMount` is not lost — the pending update
  is replayed when mount completes (as previously for async `onMount`).

### Reconcile: updating props from the parent

When `GraphRuntime.reconcile` passes new props (parent rebuilt the subtree), the HOC synchronously brings `this.props` up to date **before** the next `compose()`/`onUpdate`. In particular, if `mapStateToProps` is set, it is **recomputed synchronously** on the new props (`mapStateToProps(store.getState(), nextProps)`) — without waiting for the next store emission. This eliminates stale state-derived props when a parent prop changes.

## Important: store is not via props

`store` is not passed through props.

- For a root-connected component the store comes as the first argument of `connect(store, ...)`.
- For child connected components the store comes from internal context published by the nearest connected ancestor.

## Exports

- **Function:** `connect`.
- **Types:** `MapStateToProps`, `MapDispatchToProps`, `MapDispatchToPropsFunction`, `MapDispatchToPropsDispatchOnly`, `ActionCreatorsMap`, `ConnectOptions`, `OwnPropsMode`, `ConnectableInstance`, `ConnectableConstructor`, `ConnectableHocTarget`.

Library entry point: [Effectable/README.md](../../README.md). Store: [Effectable/store](../store/). Component: [Effectable/component](../component/).
