# Effectable Component

Base class module with state and lifecycle for GraphRuntime, [connect](../connect/connect.ts), and standalone use: types `Lifecycle`, `Disposable`, `VirtualServiceNode`, `Fiber`, `NodeLifecycleStatus`, abstract class `Component`, `GraphRuntime`, factory `h`, plus `refs` and `context` machinery.

## Structure

```text
Effectable/component/
├── index.ts        # Re-exports Component, Lifecycle, GraphRuntime, h, refs, context, lifecycle
├── types.ts        # Lifecycle, Disposable, VirtualServiceNode, Fiber, NodeLifecycleStatus
├── Component.ts    # Base class (state, props, setState, onMount, onUpdate, onUnmount, compose)
├── lifecycle.ts    # LifecycleEngine (stage/transition state machine)
├── GraphRuntime.ts # Runtime for tree materialization and reconcile
├── h.ts            # Virtual node factory (h; supports key for dynamic lists)
├── refs.ts         # @UseRef, @UseImperativeHandle
├── context.ts      # createContext, ContextProvider, @UseContext
└── README.md       # This file
```

## Types

### Lifecycle

Lifecycle interface for a GraphRuntime / connect-HOC component.

| Method | When called |
|--------|-------------|
| `onMount?()` | Once when the node mounts (subscriptions, timers, background work). |
| `onUpdate?(prev, next)` | On every state update — from `setState` or from connect-HOC (via `setState({})` after merging mapped props). |
| `onUnmount?()` | Once when the node unmounts (unsubscribe, stop effects). |

All methods are optional; override only what you need.

### Disposable

Explicit Resource Management (ECMAScript) contract: `[Symbol.dispose]()`. Used by the store to guarantee dispose; `Component` itself does not implement `Symbol.dispose` — cleanup goes through `onUnmount` and `GraphRuntime.unmount()`.

## Base class Component

`Component<S, P>` — abstract class with typed state and props.

- **Type parameters:** `S` — state type, `P` — props type (defaults to `unknown`).
- **Constructor:** `constructor(props: P, initialState?: S)`. If `initialState` is omitted, state is initialized as `{}`.
- **Fields:** `state: S`, `props: P` — public, available in subclasses and externally.

### setState(update)

Updates `state` and calls `onUpdate(prev, next)`.

- **Object:** `setState({ count: 1 })` — shallow-merged with current state (immutable: `{ ...prev, ...update }`).
- **Function:** `setState((prev, props) => ({ count: prev.count + 1 }))` — for derived updates.
- **HFT fast-path:** with `static mutableState = true`, applies updates in-place; `prev === next` in `onUpdate`.

### compose()

Optional declarative method. Returns `VirtualServiceNode | VirtualServiceNode[] | null` — a subtree described via `h(Ctor, props, children)`. Called by GraphRuntime; side effects inside are forbidden (subscriptions, network, handler registration).

**Keyed children contract:** When using the optional `key` parameter in `h(Ctor, props, key)` for dynamic lists, sibling keys MUST be unique. Duplicate keys are invalid per React v16.5 keyed child reconciliation semantics and will throw a deterministic error during reconcile. This prevents undefined matching behavior and lifecycle leaks (orphaned fibers not unmounted).

Example with unique keys:
```typescript
public override compose(): VirtualServiceNode[] {
  return this.state.items.map(item => 
    h(ItemComponent, { id: item.id }, item.id)  // key = item.id (must be unique)
  );
}
```

### Lifecycle: who calls what

- **GraphRuntime** calls `onMount → onUpdate* → onUnmount` according to LifecycleEngine state.
  `setState` during `onMount` buffers subtree reconcile and applies it after startup
  (deferred until the mount pass completes).
- **connect-HOC** overrides `onMount`/`onUnmount` on the subclass: in `onMount` it opens a store subscription and delegates to `super.onMount`, in `onUnmount` it unsubscribes and delegates to `super.onUnmount`. Each store emit is merged into `this.props` and triggers `setState({})` → `onUpdate`. When `mapStateToProps` is present, one post-mount kick-off `onUpdate` is scheduled after mount (see [connect/README.md](../connect/README.md)).
- **Component** itself only calls `onUpdate` — on every `setState`.

### GraphRuntime unmount

`GraphRuntime.unmount()` tears the tree down children-before-parent. By default the returned promise **resolves** even if cleanup or `onUnmount` fails (best-effort). Pass `{ rejectOnCleanupError: true }` to reject with `Error` (one failure) or `AggregateError` (several). `bootstrap().shutdown()` forwards the same option to `unmount()` and uses the same default.

### GraphRuntime fail-safe

Unrecoverable errors during reconcile or automatic dirty-fiber flush **fail-stop** the runtime: state becomes `FAILED`, the tree is torn down children→parent, and later `reconcile` rejects. `onAutoReconcileError` is optional observability — if the observer throws, fail-stop still runs. Dirty flush is gated on `ACTIVE` + an idle operation queue; `setState` during child materialization is buffered until the pass completes. UPDATE refs commit only after successful compose; compose/key rollback does not leave phantom parent `onUnmount` calls.

## Example: class without connect, without GraphRuntime

```typescript
import { Component } from 'Effectable/component';

interface State { count: number }

class Counter extends Component<State, { step: number }> {
  public override onUpdate (_prev: State, next: State): void {
    if (next.count % 10 === 0) {
      console.log('Reached a multiple of ten:', next.count);
    }
  }
}

const c = new Counter({ step: 1 }, { count: 0 });
c.setState({ count: 5 });
c.setState((prev) => ({ count: prev.count + 1 }));
```

## Example: class with connect and GraphRuntime

```typescript
import { Component } from 'Effectable/component';
import { connect } from 'Effectable/connect';

interface MyState { status: string }
interface Props { id: string; status?: string }

class MyServiceRaw extends Component<MyState, Props> {
  public override onMount (): void {
    console.log('Mounting, initial status:', this.props.status);
  }

  public override onUpdate (_prev: MyState, _next: MyState): void {
    console.log('status updated:', this.props.status);
  }

  public override onUnmount (): void {
    console.log('Unmounting, unsubscribe');
  }
}

export const MyService = connect(store, (state) => ({ status: state.status }))(MyServiceRaw);
// parent: h(MyService, { id: '1' })
```

## Fiber inspect (test / debug)

Public **readonly** introspection API on `GraphRuntime`. Does not export mutable `RuntimeFiber` and is not a production control plane.

- `inspectRootFiber(): FiberInspectNode | null` — deep snapshot (`effectTag`, `hasInstance`, `key`, `childCount`, `children`).
- `nullRootInstanceForTests(): void` — entity tests only: nulls the root `instance` to exercise the UPDATE guard.
- `getStableAsyncContinueCount(): number` — probe for entries into `continueStableReconcileAsync` (compare before/after around `reconcile`).

Type `FiberInspectNode` is exported from `Effectable/component`.

## Exports

From `Effectable/component`:

- **Types:** `Lifecycle`, `Disposable`, `RefObject`, `VirtualServiceNode`, `NodeLifecycleStatus`, `FiberEffectTag`, `FiberInspectNode`, `Fiber`, `ComponentConstructor`, `SetStateUpdate<S>`, `LifecycleTransitionResult`, `ContextToken`, `ContextScope`, `ContextProviderProps`, `ContextFieldMeta`, `RefFieldMeta`, `ImperativeHandleMeta`.
- **Constants:** `FIBER_EFFECT_TAG` (`PLACE` / `UPDATE` / `DELETE`; type `FiberEffectTag` = values | `null`), `RUNTIME_PROPS_RECEIVER`.
- **Classes:** `Component`, `LifecycleEngine`, `GraphRuntime`, `ContextProvider`.
- **Functions:** `h`, `UseRef`, `UseImperativeHandle`, `createContext`, `extendScope`, `readFromScope`, `UseContext`, `getContextFields`, `injectContextFields`, `getRefFields`, `getImperativeHandleMethods`, `makeFiberEffectTag`.

Library entry point: [Effectable/README.md](../../README.md). Store wiring: [Effectable/connect](../connect/).
