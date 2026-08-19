/**
 * Component-based bootstrap path for the Effectable root runtime.
 *
 * Mounts the root component via GraphRuntime (hidden in the implementation) and returns
 * a handle with the root component instance and runtime buses. GraphRuntime / h / getRootInstance
 * are not exposed — all mounting details are encapsulated here.
 *
 * @module Effectable/bootstrap/bootstrap
 */

import { Component, GraphRuntime, h, EMPTY_CONTEXT_SCOPE } from '../component';
import type { ComponentConstructor } from '../component';
import {
  CommandBus,
  EventBus,
  HandleRegistry,
  QueryBus,
} from '../runtime';
import type {
  RuntimeCommand,
  RuntimeEvent,
  RuntimeQuery,
} from '../runtime';
import type { RuntimeBusesBundle } from '../runtime/BusDecorators';
import type {
  BootstrapHandle,
  BootstrapOptions,
  BootstrapRuntimeNodeIdentity,
  BootstrapRuntimePrimitives,
} from './types';
import {
  BOOTSTRAP_RUNTIME_NODE_KIND,
  BOOTSTRAP_RUNTIME_NODE_OWNERSHIP,
} from './types';

const DEFAULT_BOOTSTRAP_NAME = 'effectable.root';

/**
 * Ownership map for runtime primitives: which objects were created inside {@link bootstrap} and must be cleared in `shutdown`.
 */
interface OwnedRuntimePrimitives {
  /** `true` — {@link CommandBus} was created here and will be cleared on shutdown. */
  commandBus: boolean;
  /** `true` — {@link QueryBus} was created here and will be cleared on shutdown. */
  queryBus: boolean;
  /** `true` — {@link EventBus} was created here and will be cleared on shutdown. */
  eventBus: boolean;
  /** `true` — {@link HandleRegistry} was created here and will be cleared on shutdown. */
  handleRegistry: boolean;
}

/**
 * Creates runtime primitives for the bootstrap path and marks which of them belong to the current handle.
 *
 * @param {Partial<BootstrapRuntimePrimitives<TCommand, TQuery, TEvent>> | undefined} providedRuntime - external runtime primitives
 * @returns {{ runtime: BootstrapRuntimePrimitives<TCommand, TQuery, TEvent>; owned: OwnedRuntimePrimitives }} set of runtime primitives and ownership map
 */
function createRuntimePrimitives<
  TCommand extends RuntimeCommand,
  TQuery extends RuntimeQuery,
  TEvent extends RuntimeEvent,
> (
  providedRuntime: Partial<BootstrapRuntimePrimitives<TCommand, TQuery, TEvent>> | undefined
): {
  runtime: BootstrapRuntimePrimitives<TCommand, TQuery, TEvent>;
  owned: OwnedRuntimePrimitives;
} {
  const providedCommandBus = typeof providedRuntime === 'undefined'
    ? undefined
    : providedRuntime.commandBus;
  const providedQueryBus = typeof providedRuntime === 'undefined'
    ? undefined
    : providedRuntime.queryBus;
  const providedEventBus = typeof providedRuntime === 'undefined'
    ? undefined
    : providedRuntime.eventBus;
  const providedHandleRegistry = typeof providedRuntime === 'undefined'
    ? undefined
    : providedRuntime.handleRegistry;

  const commandBus = typeof providedCommandBus === 'undefined'
    ? new CommandBus<TCommand>()
    : providedCommandBus;
  const queryBus = typeof providedQueryBus === 'undefined'
    ? new QueryBus<TQuery>()
    : providedQueryBus;
  const eventBus = typeof providedEventBus === 'undefined'
    ? new EventBus<TEvent>()
    : providedEventBus;
  const handleRegistry = typeof providedHandleRegistry === 'undefined'
    ? new HandleRegistry()
    : providedHandleRegistry;

  return {
    runtime: {
      commandBus,
      queryBus,
      eventBus,
      handleRegistry,
    },
    owned: {
      commandBus: typeof providedCommandBus === 'undefined',
      queryBus: typeof providedQueryBus === 'undefined',
      eventBus: typeof providedEventBus === 'undefined',
      handleRegistry: typeof providedHandleRegistry === 'undefined',
    },
  };
}

/**
 * Clears only those runtime primitives owned by the current bootstrap handle.
 *
 * @param {BootstrapRuntimePrimitives<TCommand, TQuery, TEvent>} runtime - handle runtime primitives
 * @param {OwnedRuntimePrimitives} owned - ownership map for the primitives
 * @returns {void}
 */
function clearOwnedRuntimePrimitives<
  TCommand extends RuntimeCommand,
  TQuery extends RuntimeQuery,
  TEvent extends RuntimeEvent,
> (
  runtime: BootstrapRuntimePrimitives<TCommand, TQuery, TEvent>,
  owned: OwnedRuntimePrimitives
): void {
  if (owned.commandBus) {
    runtime.commandBus.clear();
  }

  if (owned.queryBus) {
    runtime.queryBus.clear();
  }

  if (owned.eventBus) {
    runtime.eventBus.clear();
  }

  if (owned.handleRegistry) {
    runtime.handleRegistry.clear();
  }
}

/**
 * Creates an observability identity for the bootstrap-path root runtime.
 *
 * @param {string} name - bootstrap root name
 * @returns {BootstrapRuntimeNodeIdentity} root runtime identity
 */
function createBootstrapRootIdentity (name: string): BootstrapRuntimeNodeIdentity {
  return {
    rootId: name,
    nodeId: name,
    displayName: name,
    kind: BOOTSTRAP_RUNTIME_NODE_KIND.ROOT,
    ownership: BOOTSTRAP_RUNTIME_NODE_OWNERSHIP.RUNTIME_OWNED,
  };
}

/**
 * Mounts the root component via a hidden GraphRuntime and returns a handle
 * with a ready instance, runtime buses, and an idempotent `shutdown()`.
 *
 * Example:
 * ```ts
 * const handle = await bootstrap(AppRoot, { logger }, { name: 'app.root' });
 * const root = handle.rootInstance;
 * await handle.shutdown();
 * ```
 *
 * @param {ComponentConstructor<TProps>} type - root component class
 * @param {TProps} props - root component props
 * @param {BootstrapOptions<TCommand, TQuery, TEvent>} [options] - root runtime name and external runtime primitives
 * @returns {Promise<BootstrapHandle<TComponent, TProps, TCommand, TQuery, TEvent>>} handle of the running root runtime
 * @throws {Error} rethrown when mounting the root component fails
 */
export async function bootstrap<
  TProps,
  TComponent extends Component<unknown, TProps> = Component<unknown, TProps>,
  TCommand extends RuntimeCommand = RuntimeCommand,
  TQuery extends RuntimeQuery = RuntimeQuery,
  TEvent extends RuntimeEvent = RuntimeEvent,
> (
  type: ComponentConstructor<TProps>,
  props: TProps,
  options?: BootstrapOptions<TCommand, TQuery, TEvent>
): Promise<BootstrapHandle<TComponent, TProps, TCommand, TQuery, TEvent>> {
  const name = typeof options !== 'undefined' && typeof options.name === 'string' && options.name !== ''
    ? options.name
    : DEFAULT_BOOTSTRAP_NAME;
  const providedRuntime = typeof options === 'undefined' ? undefined : options.runtime;
  const onAutoReconcileError = typeof options !== 'undefined' ? options.onAutoReconcileError : undefined;
  const { runtime, owned } = createRuntimePrimitives<TCommand, TQuery, TEvent>(providedRuntime);
  const rootIdentity = createBootstrapRootIdentity(name); // TODO: remove; let this be configured automatically

  let graphRuntime: GraphRuntime | null = null;
  let rootInstance: TComponent | null = null;
  let running = false;

  try {
    graphRuntime = await GraphRuntime.mount(
      h(type, props),
      EMPTY_CONTEXT_SCOPE,
      {
        commandBus: runtime.commandBus,
        queryBus: runtime.queryBus,
        eventBus: runtime.eventBus,
      } as unknown as RuntimeBusesBundle<RuntimeCommand, RuntimeQuery, RuntimeEvent>,
      onAutoReconcileError,
    );
    const resolved = graphRuntime.getRootInstance();

    if (resolved === null) {
      throw new Error('bootstrap: root instance is null after GraphRuntime.mount');
    }

    rootInstance = resolved as TComponent;
    running = true;
  } catch (error) {
    if (graphRuntime !== null) {
      await graphRuntime.unmount();
    }
    clearOwnedRuntimePrimitives(runtime, owned);
    throw error;
  }

  // graphRuntime and rootInstance are guaranteed non-null at this point (running === true).
  const activeGraphRuntime = graphRuntime;
  const activeRootInstance = rootInstance;

  /**
   * Cached shutdown promise for concurrent shutdown callers (issue #20).
   * Ensures that multiple concurrent shutdown() calls await the same work.
   */
  let cachedShutdownPromise: Promise<void> | null = null;

  return {
    name,
    rootInstance: activeRootInstance,
    props,
    runtime,
    identity: rootIdentity,
    isRunning (): boolean {
      return running;
    },
    async reconcile (): Promise<void> {
      if (!running) {
        return;
      }

      await activeGraphRuntime.reconcile(h(type, props));
    },
    async shutdown (options?: { rejectOnCleanupError?: boolean }): Promise<void> {
      // Issue #20: concurrent shutdowns await the same promise (check cache first)
      if (cachedShutdownPromise !== null) {
        return cachedShutdownPromise;
      }

      if (!running) {
        return;
      }

      running = false;

      // Issue #20: create and cache the shutdown promise
      cachedShutdownPromise = (async (): Promise<void> => {
        try {
          await activeGraphRuntime.unmount(options);
        } finally {
          // Issue #20: always clear owned primitives even if unmount rejects
          clearOwnedRuntimePrimitives(runtime, owned);
        }
      })();

      return cachedShutdownPromise;
    },
  };
}
