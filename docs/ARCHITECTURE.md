# Effectable architecture

Short description of the **implemented** public surface. For usage details see [README.md](../README.md) and module READMEs under `src/*/README.md`.

Historical long-form draft (including unimplemented roadmap items such as `ModuleManifest`) lives in [archive/CONCEPT.md](./archive/CONCEPT.md).

## Layers

```text
bootstrap          → mounts a root Component via GraphRuntime, returns shutdown handle
  └─ component     → Component, lifecycle, h/compose, GraphRuntime, refs, context
  └─ connect       → class-based HOC linking Component ↔ store
  └─ store         → createStore, middleware, selectors, semantic state tree
  └─ runtime       → EventBus, CommandBus, QueryBus, HandleRegistry, bus decorators
```

Import from `effectable` or from subpaths: `effectable/bootstrap`, `effectable/store`, `effectable/component`, `effectable/connect`, `effectable/runtime`.

## Bootstrap

`bootstrap(RootComponent, props, options?)` creates default runtime buses (unless provided), mounts the root through `GraphRuntime`, and returns a handle with `shutdown()`.

- Process composition (env, signals, infrastructure) stays **outside** the library.
- On mount failure, owned runtime primitives are cleaned up.
- Default `shutdown()` / `GraphRuntime.unmount()` **resolve** even when cleanup or `onUnmount` fails (best-effort). Pass `{ rejectOnCleanupError: true }` to reject with `Error` or `AggregateError`.

## Component and GraphRuntime

- `Component` — long-lived node with `state` / `setState` (single writer after construction; direct `this.state =` warns), `onMount` / `onUpdate` / `onUnmount`, optional `compose()`.
- `h(...)` — declarative virtual node factory for the runtime graph.
- `GraphRuntime` — materialize, reconcile (keyed/unkeyed), lifecycle orchestration, dirty-fiber auto-flush after `setState`.
- Fail-safe: unrecoverable reconcile / dirty-flush → `FAILED`, children→parent teardown; throwing `onAutoReconcileError` cannot skip fail-stop.
- Context — `createContext`, providers, `@UseContext`.
- Refs — `@UseRef` / `@UseImperativeHandle` for GraphRuntime trees (separate from HandleRegistry aliases).

Mounted mode: lifecycle is driven by GraphRuntime. Standalone `new Component(...)` does not auto-call mount/unmount.

## Connect

Class-based HOC:

- **Root:** `connect(store, mapState?, mapDispatch?, options?)(Ctor)` — publishes store into subtree context.
- **Child:** `connect(mapState?, mapDispatch?, options?)(Ctor)` — reads store from nearest connected ancestor.

Default props mode is **strict** (parent props do not leak; use pass-through mappers). After mount with `mapStateToProps`, one deferred `onUpdate` kick-off is scheduled via microtask. Same-instance remount re-wires the store; class-field lifecycle hooks do not shadow connect subscribe/unsubscribe.

## Store

Redux-style store with RxJS:

- `createStore`, `dispatch`, `getState`, `state$`, `select`
- `applyMiddleware` / `compose` — `dispatch` during middleware construction throws (wrap + enhancer)
- `createSelector` / `createStructuredSelector`
- optional semantic state tree helpers for inspection

## Runtime buses

Thin substrate (not a general DI container):

- `EventBus`, `CommandBus`, `QueryBus`
- `HandleRegistry` + decorator wiring (`@OnCommand`, `@UseCommandBus`, …)
- `EventBus.publish` snapshots handlers; `@OnEvent` fan-out keeps every distinct method per type
- Prefer reusing buses from `bootstrap(...).runtime` rather than creating a second set

## Control plane vs data plane

| Plane | Responsibility |
| --- | --- |
| **Control** | bootstrap, `compose` / reconcile, context resolution, `connect`, lifecycle |
| **Data** | latency-sensitive work on an already-mounted graph (direct refs, pre-resolved handles, bus execute) |

Do not put hot-path work inside `compose()`, reconcile, or context resolution.

## What is not in this package

The following appear only in the archived concept draft and are **not** implemented:

- `ModuleManifest` / auto-registration
- `GraphCompiler`
- Application-specific composition roots (`src/app.ts` of a host app)
