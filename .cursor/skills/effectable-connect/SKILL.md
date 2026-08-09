---
name: effectable-connect
description: Rules for Component + connect from effectable/connect. Use when creating or refactoring connected classes, compose()/h(...) trees, GraphRuntime mount paths, or import/export patterns for connected modules.
---

# Effectable Connect

Standard for application code where classes extend `Component`, wrap with `connect` from `effectable/connect`, and mount under `GraphRuntime`.

## When to apply

- Changing any `Component` subclass that connects to a store or lives in the runtime graph.
- Adding a new service/controller with lifecycle (`onMount`, `onUpdate`, `onUnmount`).
- Changing import/export patterns for connected modules or `compose()` / `h(...)`.

## Contract sources

- Connect docs: `src/connect/README.md`
- Store API: `src/store/README.md`
- Lifecycle and Component: `src/component/README.md`, `docs/ARCHITECTURE.md`
- Bootstrap: `README.md` (Bootstrap section)

## Naming for `Component` subclasses

Classes that **extend** [`Component`](../../src/component/Component.ts) and participate in the runtime graph use the **`ServiceComponent`** suffix.

- Example: `ProjectsServiceComponent` in `projects.service.ts`, not `ProjectsConnector`.
- Props interface: `ProjectsServiceComponentProps` (domain name + `ServiceComponentProps`).

**Default export** of the module is the connected constructor for `h(...)` (see “Two `connect` modes” below). Name without the Component suffix: `ProjectsService`, `MarketSourceRegistryService`.

### Declaring `extends Component<…>`

Keep `Component` generics and mapper `Pick<…>` return types **on one line** — no line break between `<` and `>`:

```typescript
// Correct
export class ProjectsServiceComponent extends Component<Record<string, never>, ProjectsServiceComponentProps> {
  // ...
}

export function mapDispatchToProps (
  dispatch: DispatchMethod<RootAction>
): Pick<ProjectsServiceComponentProps, 'dispatchProjectsLoad'> {
  return { dispatchProjectsLoad: () => dispatch(loadProjectsAction()) };
}

// Incorrect — wrapping generic parameters across lines
export class ProjectsServiceComponent extends Component<
  Record<string, never>,
  ProjectsServiceComponentProps
> {
  // ...
}
```

## Two `connect` modes

`connect` supports **two forms** (see `src/connect/connect.ts` and README):

| Mode | Call | Store | Typical place |
|------|------|-------|---------------|
| **Root-connected** | `connect(store, mapState?, mapDispatch?, options?)(Ctor)` | Explicit `store` as first argument | App root (`app.ts`), rarely API controllers |
| **Child-connected** | `connect(mapStateToProps?, mapDispatchToProps?, options?)(Ctor)` | From **context** of nearest connected ancestor | Almost all domain `*.service.ts` under the root |

### Root-connected (graph root)

Pass a single store instance into `connect` **in the root module**, not in the process entrypoint:

```typescript
// app.ts
export default (store: Store<RootState, RootAction>) => connect(
  store,
  mapApplicationRootStateToProps
)(ApplicationRoot);
```

Entrypoint (`index.ts`) calls the factory and passes the connected constructor to `bootstrap`:

```typescript
const ConnectedApplicationRoot = connectApplicationRoot(rootStore);
const handle = await bootstrap({
  name: 'src.app',
  RootComponent: ConnectedApplicationRoot,
  props: { /* process deps — NOT store for child HOC subscription */ },
});
```

A root-connected node **publishes** the store into the subtree via internal context; child `connect(mapStateToProps, mapDispatchToProps)(…)` receives the store automatically.

### Child-connected (domain services — primary pattern)

Do **not** pass the store into the factory or into `h(...)`. At the end of `*.service.ts`:

```typescript
const ProjectsService = connect(
  mapStateToProps,
  mapDispatchToProps
)(ProjectsServiceComponent) as ComponentConstructor<unknown>;

export default ProjectsService;
```

In a child-connected module, mapper functions are **strictly** named `mapStateToProps` and `mapDispatchToProps` (not `mapProjectsStateToProps`, etc.) — one module = one class = canonical names.

In the parent `compose()`:

```typescript
h(ProjectsService, { databaseService: this.props.databaseService }, this.projectsServiceRef);
```

**Not** `h(ProjectsService(store), …)` — the child-connected constructor is already wrapped; the store comes from root context.

### Which mode to use

- **Root** — only the node mounted first with an explicit `rootStore` (e.g. `ApplicationRoot`).
- **Child** — any service under a connected root that needs a store slice or dispatch from the same `rootStore`.
- **No `connect`** — the component does not read the store (see below).

## Strict props (default) and pass-through

Default `connect` is **`strict`** (`ownPropsModeMerge` unset or `false`):

- Parent props from `h(ConnectedCtor, props)` do **not** leak into `this.props` automatically.
- `this.props` only gets what `mapStateToProps` / `mapDispatchToProps` explicitly return.

To forward a domain dependency from `h(...)` (`databaseService`, registries, ref objects), use **pass-through** in `mapStateToProps`:

```typescript
type ProjectsOwnProps = Pick<ProjectsServiceComponentProps, 'databaseService'>;

export function mapStateToProps (
  _state: RootState,
  props: ProjectsOwnProps
): ProjectsOwnProps {
  return {
    databaseService: props.databaseService,
  };
}
```

Pass-through rules:

- Second argument `props` — **parent props** from `h(...)`.
- `_state` may be unused when the mapper only forwards own props (common case).
- For a store slice — selectors in `mapStateToProps(state, props)`; add own props to the same return when needed.
- Type own props via `Pick<…ServiceComponentProps, '…'>`.

On **reconcile** (parent rebuilt the subtree with new props) the HOC **synchronously** recomputes `mapStateToProps(store.getState(), nextProps)` before the next `compose()` / `onUpdate` — do not wait for the next store emission.

## ownPropsModeMerge (legacy, intentional only)

Option **`{ ownPropsModeMerge: true }`** enables legacy merge: parent props forward into `this.props` without a mapper.

```typescript
const TestSystemExecService = connect(
  undefined,
  mapDispatchToProps,
  { ownPropsModeMerge: true }
)(TestSystemExecServiceComponent) as ComponentConstructor<unknown>;
```

Use **only** when:

- the component reads own props from `h(...)`, but pass-through in `mapStateToProps` causes a problem (e.g. selector always returns a new object → `setState` → `onUpdate` → dispatch → stack overflow);
- migration to strict is incomplete.

**Do not** enable by default. Target contract is strict + explicit pass-through.

## Components without `connect` in the same graph

Not every `*ServiceComponent` must be connected. If a node does **not** read the store and does **not** need dispatch from `mapDispatchToProps`, mount the **raw class**:

```typescript
h(PositionStoreServiceComponent, {
  supportedExchanges: this.props.supportedExchanges,
  databaseService: this.props.databaseService,
}, this.positionStoreRef);
```

`connect` is needed when the component:

- subscribes to a slice via `mapStateToProps`, or
- receives dispatch callbacks via `mapDispatchToProps`.

## Store and props: allowed vs forbidden

| Situation | Allowed? |
|-----------|----------|
| `connect(store, …)(Ctor)` — store in HOC | Yes, root only (or an explicit root subgraph) |
| Child `connect(mapStateToProps, mapDispatchToProps)(Ctor)` — store from context | Yes, primary pattern |
| `h(ChildConnected, { databaseService })` — domain deps | Yes; in strict — via pass-through mapper |
| `h(ChildConnected, { store: rootStore })` for HOC subscription | **No** — store is not in child connected props |
| `appStore: rootStore` on **root** props + pass-through in root mapper | Yes — composition-root exception (hand out a reference for Express/API, etc.), **not** for child-HOC subscription |
| Global store singleton (`getGlobalStore()`-style) | **No** |

## Default export in `*.service.ts`

End of file — **one** `connect` call for the local `*ServiceComponent` and default-export the connected constructor.

**Child-connected (typical):**

```typescript
const DatasetService = connect(
  mapStateToProps,
  mapDispatchToProps
)(DatasetServiceComponent) as ComponentConstructor<unknown>;

export default DatasetService;
```

**Root-connected (root / rare entry only):**

```typescript
export default (store: Store<RootState, RootAction>) => connect(
  store,
  mapApplicationRootStateToProps
)(ApplicationRoot);
```

**Strictly forbidden** in `*.service.ts`:

- `connect(getGlobalStore(), …)(…)` and any global store singleton.
- Caching `connect` results in `WeakMap`/`Map`, or `let Ctor` with branching.
- `export { SomeServiceComponent as LegacyName }` in the same file — aliases belong in barrels.

## Member order (`extends Component`)

1. **Fields** — `static`, then instance (`@UseRef()` with `declare`, private fields, subscriptions).
2. **`constructor`** — `super(props)`; assign `this.state = …` after `super` (no `super(props, initialState)` — see `effectable-store`).
3. **Lifecycle** — `onMount`, `onUpdate`, `onUnmount` (`async onMount` allowed).
4. **External contract** — HTTP, bus handlers, public API methods.
5. **Internal methods** — `private` / `protected`.
6. **`compose`** — last; declarative subtree via `h(...)` only, no side effects.

## Where `connect` may be called

Call `connect(…)(ThisClass)` **only** in the module that declares the class (next to `mapStateToProps` / `mapDispatchToProps` for child-connected).

- **Forbidden**: declare `ApplicationRoot` in `app.ts` but call `connect(...)(ApplicationRoot)` only in `index.ts`.
- **Forbidden**: `connect(...)(ClassFromModuleB)` in module A.
- **Outside**, import only the default-exported connected constructor (`ProjectsService`), not the raw class for a second `connect`.

## Connected HOC lifecycle

Order for a connected class in mounted mode (`GraphRuntime`):

1. `new ConnectedCtor(props)` — in strict, parent props are not in `this.props` without a mapper.
2. HOC `onMount`: merge `mapDispatchToProps` → if `mapStateToProps` exists, subscribe to `store.select`.
3. **First** selector emission: merge state props → **`super.onMount`** (your code sees full `this.props`).
4. Later store emissions: merge → `setState({})` → **`onUpdate`** (even if `state` did not change — react to store-derived props).
5. Reconcile with new parent props: synchronous recompute of `mapStateToProps` / dispatch props.
6. HOC `onUnmount`: unsubscribe → `super.onUnmount`.

**Async `onMount`:** if `super.onMount` returns a Promise, store emissions before mount completes **defer** `setState`/`onUpdate`; after resolve — one deferred update. On mount error — unsubscribe; no half-mounted node.

**Standalone** (`new Component` without GraphRuntime): `setState` → `onUpdate` without the “after mount” gate; `onMount`/`onUnmount` are not called automatically.

## `compose()`, `h()`, and refs

- `compose()` — pure topology: `h(Ctor, props, ref?)` or `h(Ctor)` with empty props, conditionals, keyed lists.
- **Forbidden in `compose()`:** network I/O, bus subscriptions, handler registration, mutating global state.
- Side effects — only in `onMount` / `onUnmount` (and domain methods called from lifecycle).
- For props `Record<string, never>` — **`h(Ctor)`**, no second argument.
- **Forbidden** `h(Ctor, {})`: an empty object as the second argument is meaningless. Refs/children with empty props: `h(Ctor, undefined, ref)` / `h(Ctor, undefined, children)`.

**Refs** (`@UseRef`, `h(Child, props, ref)` from `effectable/component`):

```typescript
@UseRef()
public declare marketDataServiceRef: RefObject<MarketDataServiceComponent>;

public override compose (): VirtualServiceNode[] {
  return [
    h(SharedClientServiceComponent),
    h(MarketDataService, { adapterRegistry: this.props.adapterRegistry }, this.marketDataServiceRef),
  ];
}
```

In `onMount`, check `ref.current` explicitly (`if (ref.current === null) { throw … }`).

Refs are for imperative subtree APIs and lifecycle ordering; **not** a substitute for `connect` and **not** the primary cross-domain channel (use CommandBus / HandleRegistry).

**Nested connected nodes:** a child `connect` under a parent connected node automatically gets the same store from context.

## Bootstrap entrypoint

Typical process composition:

1. `createStore` + middleware → `rootStore`.
2. `const ConnectedRoot = connectApplicationRoot(rootStore)` — factory from `app.ts`.
3. `await bootstrap({ name, RootComponent: ConnectedRoot, props, … })` (optionally with shared runtime buses / HandleRegistry).
4. Root props — process dependencies + optional `appStore: rootStore` for outward references; **do not** pass `store` as a prop for child-HOC subscription.
5. Shutdown — `handle.shutdown()` → `onUnmount` in reverse order.

## Mapper names

### Child-connected (`connect(mapStateToProps, mapDispatchToProps)(Ctor)`)

**Strictly** only these function names in the module:

- **`mapStateToProps`** — `(state, props) => …`
- **`mapDispatchToProps`** — `(dispatch) => …`, `(dispatch, props) => …`, or an action-creators object

**Forbidden** in child-connected `*.service.ts`: `mapProjectsStateToProps`, `mapDatasetDispatchToProps`, any domain prefix. File context already identifies the component.

Call `connect` with **exactly** these identifiers:

```typescript
connect(mapStateToProps, mapDispatchToProps)(ProjectsServiceComponent);
```

### Root-connected (`connect(store, …)(Ctor)`)

Root and rare entries with an explicit `store` may use a domain-prefixed mapper if it is re-exported, e.g. **`mapApplicationRootStateToProps`**. Inside the same file, canonical `mapStateToProps` is fine when there is no name clash.

## mapStateToProps and mapDispatchToProps

- **mapStateToProps** — `(state, props) => R`; if omitted — no `store.select` subscription.
- **mapDispatchToProps** — three forms:
  - short `(dispatch) => { … }` — pass the function directly, not `(d) => mapX(d)`;
  - full `(dispatch, props) => { … }` — **two parameters without a default** on the second, otherwise `function.length === 1` and `props` is not passed;
  - action-creators object `{ prop: (...args) => action }` — each method binds as `dispatch(actionCreator(...))`.

```typescript
export function mapDispatchToProps (
  dispatch: DispatchMethod<RootAction>
): Pick<ProjectsServiceComponentProps, 'dispatchProjectsLoad'> {
  return {
    dispatchProjectsLoad: () => dispatch(loadProjectsAction()),
  };
}
```

- Dispatch callbacks on the props interface are **optional** (`dispatchXxx?: …`); the HOC guarantees them before `onMount`.
- **Forbidden** to spread/call another component’s `mapDispatchToProps` — only local callbacks; share logic via action creators.
- Use selectors in `mapStateToProps`, not raw deep field access as a substitute for selectors when the slice is shared.
- **Forbidden** global store singletons — data from state only via mapper → `this.props`.

## Architecture model

`connect` is a class-based HOC: a subclass overrides `onMount`/`onUnmount`, merges mapped props, and delegates lifecycle to `super`.

Use the connected constructor in `compose()` via `h(ConnectedCtor, props, ref?)`, not `new ConnectedCtor(...)` by hand in bootstrap code.

## HandleRegistry vs imperative handle

Separate from GraphRuntime refs (`UseRef` / `h(..., ref)`):

- **HandleRegistry** registration: `HandleRegistryUseRef`, `HandleRegistryUseImperativeHandle`, `handleRegistry.autoRegister(instance)`.
- Do not manually rebuild the same surface on the service — follow the HandleRegistry contract.

## Typing

- Do not use `as any`.
- Result of `connect(...)(…)` — `as ComponentConstructor<unknown>` (or with own-props type) for `h()`.

## Strictly forbidden

- Global store singletons / `connect(getGlobalStore(), …)` in any connected code.
- Reading store state inside `*ServiceComponent` except via `this.props` from mappers.
- Caching `connect` in `*.service.ts`.
- `export { FooServiceComponent as Bar }` in the same `*.service.ts`.
- `h(ChildConnected, { store, … })` — store not in props for child-HOC subscription.
- `connect(...)(ClassFromAnotherModule)`.
- `connect(...)(ApplicationRoot)` in `index.ts` instead of a factory in `app.ts`.
- Passing `*Ctor`, `engineCtor` through props as a domain API.
- `export default (props) => connect(...)(Class)(props)` — not an instance factory.
- Legacy hooks `onInit`/`onDestroy`/`onBeforeInit`, `[Symbol.dispose]`.
- Side effects inside `compose()`.
- In child-connected modules, domain-prefixed mappers instead of **`mapStateToProps`** / **`mapDispatchToProps`**.
- `h(Ctor, {})` for empty props — only `h(Ctor)`.

## Checklist before finishing

- [ ] Member order: fields → constructor → lifecycle → external handlers → internal methods → `compose`.
- [ ] `connect(…)(Ctor)` only in `Ctor`’s module; outside — default-exported constructor.
- [ ] Root: `connect(store, …)(ApplicationRoot)` in `app.ts`; child: `connect(mapStateToProps, mapDispatchToProps)(…)` with no store in `h()`.
- [ ] Child-connected: mappers named **`mapStateToProps`** and **`mapDispatchToProps`** (no domain prefix).
- [ ] `extends Component<State, Props>` and mapper `Pick<…>` — **one line**, no wrapped generics.
- [ ] Strict props: own props from `h(...)` forwarded via `mapStateToProps(state, props)` (or intentional `ownPropsModeMerge`).
- [ ] No global store singleton; no `store` in child-connected props.
- [ ] `mapDispatchToProps` is local; if `props` is needed in dispatch — two parameters, no default.
- [ ] `compose()` has no side effects; refs via `@UseRef` + third `h(...)` argument.
- [ ] Empty props: `h(Ctor)`, not `h(Ctor, {})`.
- [ ] No legacy lifecycle hooks or `Symbol.dispose`.
