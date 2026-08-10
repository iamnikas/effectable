# Effectable

[![npm](https://img.shields.io/npm/v/effectable.svg)](https://www.npmjs.com/package/effectable)
[![CI](https://github.com/iamnikas/effectable/actions/workflows/ci.yml/badge.svg)](https://github.com/iamnikas/effectable/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node.js](https://img.shields.io/node/v/effectable.svg)](https://nodejs.org)

Reactive layer library: explicit bootstrap-path, Redux-RxJS store, base class with lifecycle, class-based HOC `connect`, and GraphRuntime with a declarative component tree (`h`, `compose`).

## Installation

Requires **Node.js 18.18+** and **npm 9+**.

```bash
npm install effectable
```

```typescript
import { bootstrap, connect, createStore, Component, h } from 'effectable';
```

Subpackages: `effectable/bootstrap`, `effectable/store`, `effectable/component`, `effectable/connect`, `effectable/runtime`.

## Structure

```text
Effectable/
├── src/
│   ├── index.ts         # Re-exports bootstrap, store, component, connect, runtime
│   ├── bootstrap/       # Explicit root bootstrap, runtime handle, and default runtime primitives
│   ├── store/           # Redux-RxJS store (createStore, select, state$)
│   ├── component/       # Lifecycle, Component (state, setState, onMount, onUpdate, onUnmount), GraphRuntime, refs, context
│   ├── connect/         # connect(store, mapStateToProps)(MyClass) -> ConnectedClass (class-based HOC)
│   └── runtime/         # EventBus, CommandBus, QueryBus, HandleRegistry, BusDecorators
├── tests/               # Unit and integration Jest tests
├── benchmarks/          # Performance suites (`npm run bench`)
├── docs/                # Architecture notes (`docs/ARCHITECTURE.md`)
└── examples/            # Usage examples outside production build
```

Architecture overview: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).


## Bootstrap

`bootstrap(...)` — explicit root runtime entry contract.

- Creates `EventBus`, `CommandBus`, `QueryBus`, and `HandleRegistry` when the caller does not pass them explicitly.
- Mounts the root component via `GraphRuntime` (including ones wrapped with `connect`).
- Returns a handle with `shutdown()` for graceful teardown: calls `onUnmount` in reverse order.
- On startup failure, automatically cleans up already created runtime primitives.

### Bootstrap-path example

```typescript
import { bootstrap, connect } from 'effectable';
import { AppRoot, mapStateToProps } from './app';
import { store } from './store';

const ConnectedAppRoot = connect(store, mapStateToProps)(AppRoot);

const handle = await bootstrap(
  ConnectedAppRoot,
  { /* refs, handles — BUT NOT store */ },
  { name: 'app.root' },
);

await handle.shutdown(); // graceful teardown via onUnmount
```

## Host application roles

In a consuming app, keep process concerns outside Effectable:

1. **Process entry** — env/config, signal handlers, infrastructure adapters, then `bootstrap(...)`.
2. **Root component** — extends `Component`, implements `compose()`, optional `onMount`/`onUnmount`; wrap with `connect(store, map)(Root)` so the store is injected by the HOC, not via props.
3. On shutdown call `handle.shutdown()`.

## Control plane / data plane boundary

- **Control plane**: `bootstrap`, lifecycle orchestration (`onMount`/`onUnmount`), reconcile, context resolution, HOC `connect`.
- **Data plane**: latency-sensitive work on an already-mounted graph.

Rules:

- `compose()`, reconcile, and context resolution must not sit on the hot execution path.
- Data-plane components use direct refs and pre-resolved handles for the fast path.
- `GraphRuntime` manages lifecycle; it is not meant to run on every high-frequency tick.

## Store

See [src/store/README.md](src/store/README.md): creating a store, selectors, middleware, `state$`, `select()`.

## Component and connect

Pattern for wiring a class to the store without manual subscriptions: reactive `state`, lifecycle hooks, automatic unsubscribe on unmount.

### Lifecycle

- **onMount** — once when the node mounts (start subscriptions, timers, background work).
- **onUpdate(prev, next)** — on every state update (from `setState`; in a connected class also on every store emit).
- **onUnmount** — once when the node unmounts (tear down subscriptions, stop effects).

A connected class with `mapStateToProps` receives **one deferred** `onUpdate` after mount
(post-mount kick-off) — see the migration note in [src/connect/README.md](src/connect/README.md).
`setState` inside `onMount` in GraphRuntime buffers subtree reconcile and applies it after
startup (same idea as deferring an update until after the mount pass completes).

### Example: class and connect

```typescript
import { createStore } from 'effectable/store';
import { Component } from 'effectable/component';
import { connect } from 'effectable/connect';

interface AppState { status: string }
interface Props { id: string; status?: string }

class MyServiceRaw extends Component<never, Props> {
  public override onMount (): void {
    console.log('Mounting, status:', this.props.status);
  }

  public override onUpdate (_prev: never, _next: never): void {
    console.log('status updated:', this.props.status);
  }

  public override onUnmount (): void {
    console.log('Unmounting, tear down subscriptions');
  }
}

const store = createStore(reducer, initialState);
const mapStateToProps = (state: AppState) => ({ status: state.status });

export const MyService = connect(store, mapStateToProps)(MyServiceRaw);

// in the parent's compose():
//   h(MyService, { id: '1' })
```

`store` is passed into the HOC `connect` (closure) and MUST NOT appear in the component `props`.

## Entry points

- `effectable` — canonical public entrypoint (`bootstrap`, store, component, connect, runtime)
- `effectable/bootstrap` — explicit root bootstrap-path
- `effectable/store` — store
- `effectable/component` — Component, Lifecycle, GraphRuntime, h, refs, context
- `effectable/connect` — connect, MapStateToProps, ConnectOptions
- `effectable/runtime` — EventBus, CommandBus, QueryBus, HandleRegistry, BusDecorators (`wireRuntimeBuses`, **`wireRuntimeBusesAll`** — wire several handlers to the same bus set; process code usually reuses the same `commandBus` / `queryBus` / `eventBus` as `bootstrap(...).runtime`, without a second `createRuntimeBuses` / `HandleRegistry`)

## Contributing

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/) (enforced by commitlint + lefthook). The same messages drive [semantic-release](https://semantic-release.app/) version bumps (`feat` → minor, `fix`/`perf` → patch, breaking → major).

```text
feat: add HandleRegistry autoRegister example
fix: buffer setState during onMount
docs: clarify bootstrap shutdown
```

After `npm ci`, lefthook installs a local `commit-msg` hook. CI also lint-checks PR commits. Prefer Conventional Commits for squash-merge titles too.

## Publishing

- **Canary** (`develop`): `npm install effectable@canary`
- **Stable** (`main`): `npm install effectable`

Versions are bumped automatically by semantic-release in CI. Details: [docs/PUBLISHING.md](docs/PUBLISHING.md).

## License

MIT © 2025–2026 Nick Nask, also known as Nikita Neskuchaev ([iamnikas](https://github.com/iamnikas)). See [LICENSE](./LICENSE).
