/**
 * Types of the Effectable bootstrap subsystem.
 *
 * bootstrap mounts the root component via GraphRuntime (hidden in the implementation)
 * and returns a handle with the root component instance and runtime buses.
 *
 * @module Effectable/bootstrap/types
 */

import type { Component } from '../component';
import type {
  CommandBus,
  EventBus,
  HandleRegistry,
  QueryBus,
  RuntimeCommand,
  RuntimeEvent,
  RuntimeQuery,
} from '../runtime';

/**
 * Categories of runtime nodes in the bootstrap path.
 */
export const BOOTSTRAP_RUNTIME_NODE_KIND = {
  ROOT: 'ROOT',
  MOLECULE: 'MOLECULE',
} as const;
export type BootstrapRuntimeNodeKind =
  (typeof BOOTSTRAP_RUNTIME_NODE_KIND)[keyof typeof BOOTSTRAP_RUNTIME_NODE_KIND];

/**
 * Ownership modes for a runtime node in the bootstrap path.
 */
export const BOOTSTRAP_RUNTIME_NODE_OWNERSHIP = {
  RUNTIME_OWNED: 'RUNTIME_OWNED',
  COMPATIBILITY_BRIDGE: 'COMPATIBILITY_BRIDGE',
} as const;
export type BootstrapRuntimeNodeOwnership =
  (typeof BOOTSTRAP_RUNTIME_NODE_OWNERSHIP)[keyof typeof BOOTSTRAP_RUNTIME_NODE_OWNERSHIP];

/**
 * Observability identity of the root node in the bootstrap path.
 */
export interface BootstrapRuntimeNodeIdentity {
  rootId: string;
  nodeId: string;
  displayName: string;
  kind: BootstrapRuntimeNodeKind;
  ownership: BootstrapRuntimeNodeOwnership;
}

/**
 * Full set of runtime primitives raised by the bootstrap path by default.
 * Includes four buses: command / query / event and HandleRegistry.
 */
export interface BootstrapRuntimePrimitives<
  TCommand extends RuntimeCommand = RuntimeCommand,
  TQuery extends RuntimeQuery = RuntimeQuery,
  TEvent extends RuntimeEvent = RuntimeEvent,
> {
  commandBus: CommandBus<TCommand>;
  queryBus: QueryBus<TQuery>;
  eventBus: EventBus<TEvent>;
  handleRegistry: HandleRegistry;
}

/**
 * Optional parameters for a bootstrap call.
 *
 * @template TCommand - command family type
 * @template TQuery - query family type
 * @template TEvent - event family type
 */
export interface BootstrapOptions<
  TCommand extends RuntimeCommand = RuntimeCommand,
  TQuery extends RuntimeQuery = RuntimeQuery,
  TEvent extends RuntimeEvent = RuntimeEvent,
> {
  /** Root runtime name; defaults to `effectable.root`. */
  name?: string;
  /** Partially or fully external runtime primitives; missing ones are created internally. */
  runtime?: Partial<BootstrapRuntimePrimitives<TCommand, TQuery, TEvent>>;
  /**
   * Hook invoked on automatic reconcile failure (triggered by `setState()`).
   * Allows logging or handling errors that would otherwise be ignored.
   */
  onAutoReconcileError?: (err: unknown) => void;
}

/**
 * Handle of a running root runtime.
 *
 * @template TComponent - root component class
 * @template TProps - root component props
 * @template TCommand - command family type
 * @template TQuery - query family type
 * @template TEvent - event family type
 */
export interface BootstrapHandle<
  TComponent extends Component<unknown, TProps>,
  TProps,
  TCommand extends RuntimeCommand = RuntimeCommand,
  TQuery extends RuntimeQuery = RuntimeQuery,
  TEvent extends RuntimeEvent = RuntimeEvent,
> {
  /** Root runtime name. */
  name: string;
  /** Root component instance that has already completed full startup. */
  rootInstance: TComponent;
  /** Props passed to the root component at bootstrap. */
  props: TProps;
  /** Runtime primitives (buses and registry) of the current handle. */
  runtime: BootstrapRuntimePrimitives<TCommand, TQuery, TEvent>;
  /** Observability identity of the root runtime. */
  identity: BootstrapRuntimeNodeIdentity;
  /**
   * Checks whether the handle is still active (before shutdown).
   *
   * @returns {boolean} true if the handle has not been shut down yet
   */
  isRunning(): boolean;
  /**
   * Rebuilds the root runtime tree with the original props.
   * Needed by external reactive sources because `Component.setState()` does not reconcile the subtree.
   *
   * @returns {Promise<void>} completion of the reconcile pass
   */
  reconcile(): Promise<void>;
  /**
   * Idempotently shuts down the root runtime: unmounts the tree and clears owned buses.
   *
   * @returns {Promise<void>}
   */
  shutdown(): Promise<void>;
}
