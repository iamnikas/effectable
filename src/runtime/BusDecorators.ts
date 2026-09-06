/**
 * Decorators and wiring for CommandBus / QueryBus / EventBus.
 *
 * Property: `@UseCommandBus()`, `@UseQueryBus()`, `@UseEventBus()` — inject a bus instance into a field.
 * Method: `@OnCommand(type)`, `@OnQuery(type)`, `@OnEvent(type)` — register a method as a handler.
 *
 * After creating an instance, call `wireRuntimeBuses(instance, buses)`; it returns a disposer.
 *
 * @module Effectable/runtime/BusDecorators
 */

import 'reflect-metadata';

import { CommandBus } from './CommandBus';
import { EventBus } from './EventBus';
import { QueryBus } from './QueryBus';
import type {
  CommandHandler,
  EventHandler,
  QueryHandler,
  RuntimeCommand,
  RuntimeEvent,
  RuntimeQuery,
} from './types';

const USE_COMMAND_BUS_PROPS = 'effectable:runtime:UseCommandBus:props';
const USE_QUERY_BUS_PROPS = 'effectable:runtime:UseQueryBus:props';
const USE_EVENT_BUS_PROPS = 'effectable:runtime:UseEventBus:props';
const ON_COMMAND_ENTRIES = 'effectable:runtime:OnCommand:entries';
const ON_QUERY_ENTRIES = 'effectable:runtime:OnQuery:entries';
const ON_EVENT_ENTRIES = 'effectable:runtime:OnEvent:entries';

function appendPropKey (ctor: Function, metaKey: string, propertyKey: string | symbol): void {
  const key = String(propertyKey);
  const current = Reflect.getOwnMetadata(metaKey, ctor) as string[] | undefined;
  const next = typeof current === 'undefined' ? [key] : [...current, key];
  Reflect.defineMetadata(metaKey, next, ctor);
}

function appendHandlerEntry (
  ctor: Function,
  metaKey: string,
  entry: { type: string; method: string }
): void {
  const current = Reflect.getOwnMetadata(metaKey, ctor) as Array<{ type: string; method: string }> | undefined;
  const next = typeof current === 'undefined' ? [entry] : [...current, entry];
  Reflect.defineMetadata(metaKey, next, ctor);
}

/**
 * Marks a field for CommandBus instance injection in `wireRuntimeBuses`.
 *
 * @returns {PropertyDecorator} property decorator
 */
export function UseCommandBus (): PropertyDecorator {
  return (target, propertyKey) => {
    appendPropKey(target.constructor as Function, USE_COMMAND_BUS_PROPS, propertyKey);
  };
}

/**
 * Marks a field for QueryBus instance injection in `wireRuntimeBuses`.
 *
 * @returns {PropertyDecorator} property decorator
 */
export function UseQueryBus (): PropertyDecorator {
  return (target, propertyKey) => {
    appendPropKey(target.constructor as Function, USE_QUERY_BUS_PROPS, propertyKey);
  };
}

/**
 * Marks a field for EventBus instance injection in `wireRuntimeBuses`.
 *
 * @returns {PropertyDecorator} property decorator
 */
export function UseEventBus (): PropertyDecorator {
  return (target, propertyKey) => {
    appendPropKey(target.constructor as Function, USE_EVENT_BUS_PROPS, propertyKey);
  };
}

/**
 * Registers a method as the sole command handler for the given type (via CommandBus.register).
 *
 * @param {string} commandType - string command type
 * @returns {MethodDecorator} method decorator
 */
export function OnCommand (commandType: string): MethodDecorator {
  return (target, propertyKey) => {
    appendHandlerEntry(target.constructor as Function, ON_COMMAND_ENTRIES, {
      type: commandType,
      method: String(propertyKey),
    });
  };
}

/**
 * Registers a method as the sole query handler for the given type (via QueryBus.register).
 *
 * @param {string} queryType - string query type
 * @returns {MethodDecorator} method decorator
 */
export function OnQuery (queryType: string): MethodDecorator {
  return (target, propertyKey) => {
    appendHandlerEntry(target.constructor as Function, ON_QUERY_ENTRIES, {
      type: queryType,
      method: String(propertyKey),
    });
  };
}

/**
 * Subscribes a method to events of the given type (via EventBus.subscribe).
 *
 * @param {string} eventType - string event type
 * @returns {MethodDecorator} method decorator
 */
export function OnEvent (eventType: string): MethodDecorator {
  return (target, propertyKey) => {
    appendHandlerEntry(target.constructor as Function, ON_EVENT_ENTRIES, {
      type: eventType,
      method: String(propertyKey),
    });
  };
}

/**
 * Bundle of three buses of one compatible type family.
 */
export interface RuntimeBusesBundle<
  TCommand extends RuntimeCommand = RuntimeCommand,
  TQuery extends RuntimeQuery = RuntimeQuery,
  TEvent extends RuntimeEvent = RuntimeEvent,
> {
  commandBus: CommandBus<TCommand>;
  queryBus: QueryBus<TQuery>;
  eventBus: EventBus<TEvent>;
}

/**
 * Creates a new bus bundle (without hidden auto-binding to global state).
 *
 * @template TCommand
 * @template TQuery
 * @template TEvent
 * @returns {RuntimeBusesBundle<TCommand, TQuery, TEvent>} three new bus instances
 */
export function createRuntimeBuses<
  TCommand extends RuntimeCommand = RuntimeCommand,
  TQuery extends RuntimeQuery = RuntimeQuery,
  TEvent extends RuntimeEvent = RuntimeEvent,
> (): RuntimeBusesBundle<TCommand, TQuery, TEvent> {
  return {
    commandBus: new CommandBus<TCommand>(),
    queryBus: new QueryBus<TQuery>(),
    eventBus: new EventBus<TEvent>(),
  };
}

function getStringPropKeys (ctor: Function, metaKey: string): string[] {
  const own = Reflect.getOwnMetadata(metaKey, ctor) as string[] | undefined;
  return typeof own === 'undefined' ? [] : [...own];
}

function getHandlerEntries (ctor: Function, metaKey: string): Array<{ type: string; method: string }> {
  const own = Reflect.getOwnMetadata(metaKey, ctor) as Array<{ type: string; method: string }> | undefined;
  return typeof own === 'undefined' ? [] : [...own];
}

/**
 * Constructor chain from leaf (instance.constructor) to base (prototype chain of functions).
 * Needed for `connect` HOC: decorator metadata often lives on the base class while the instance is a subclass.
 *
 * @param {Function} leafCtor - instance constructor (subclass)
 * @returns {Function[]} leaf-first: [Child, Parent, ...]
 */
function getConstructorChainLeafFirst (leafCtor: Function): Function[] {
  const chain: Function[] = [];
  const seen = new Set<Function>();
  let current: Function | null = leafCtor;

  while (current != null && typeof current === 'function' && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    const next = Object.getPrototypeOf(current);
    if (typeof next !== 'function' || next === null) {
      break;
    }
    current = next;
  }

  return chain;
}

/**
 * Returns true if the instance (or its base classes) has metadata for {@link wireRuntimeBuses}.
 *
 * @param {object} instance - component instance
 * @returns {boolean}
 */
export function instanceUsesRuntimeBusDecorators (instance: object): boolean {
  const leafCtor = instance.constructor as Function;
  const chain = getConstructorChainLeafFirst(leafCtor);

  for (const ctor of chain) {
    if (
      getStringPropKeys(ctor, USE_COMMAND_BUS_PROPS).length > 0 ||
      getStringPropKeys(ctor, USE_QUERY_BUS_PROPS).length > 0 ||
      getStringPropKeys(ctor, USE_EVENT_BUS_PROPS).length > 0 ||
      getHandlerEntries(ctor, ON_COMMAND_ENTRIES).length > 0 ||
      getHandlerEntries(ctor, ON_QUERY_ENTRIES).length > 0 ||
      getHandlerEntries(ctor, ON_EVENT_ENTRIES).length > 0
    ) {
      return true;
    }
  }

  return false;
}

/**
 * Collects exclusive `@OnCommand` / `@OnQuery` type strings declared on a
 * component constructor chain (used to free only slots a PLACE/REPLACE needs).
 *
 * @param {unknown} componentType - vnode `type` (component constructor or other)
 * @returns {{ commandTypes: Set<string>; queryTypes: Set<string> }} declared exclusive types
 */
export function collectExclusiveHandlerTypesFromType (componentType: unknown): {
  commandTypes: Set<string>;
  queryTypes: Set<string>;
} {
  const commandTypes = new Set<string>();
  const queryTypes = new Set<string>();

  if (typeof componentType !== 'function') {
    return { commandTypes, queryTypes };
  }

  for (const ctor of getConstructorChainLeafFirst(componentType)) {
    for (const { type } of getHandlerEntries(ctor, ON_COMMAND_ENTRIES)) {
      commandTypes.add(type);
    }
    for (const { type } of getHandlerEntries(ctor, ON_QUERY_ENTRIES)) {
      queryTypes.add(type);
    }
  }

  return { commandTypes, queryTypes };
}

/**
 * Unregisters exclusive `@OnCommand` / `@OnQuery` handlers for an instance.
 *
 * Used when an orphan must release exclusive bus slots before a same-batch
 * PLACE/REPLACE registers the same types, while leaving `@OnEvent` subscriptions
 * intact so a deferred sibling UPDATE can still publish into the orphan before destroy.
 *
 * When `onlyTypes` is provided, only those command/query types are unregistered.
 * Callers should pass the incoming vnode's declared exclusive types so orphans that
 * are not conflicting with a PLACE keep their handlers through deferred UPDATEs
 * (UPDATE `execute`/`query` handoff before orphan destroy).
 *
 * The instance's full {@link wireRuntimeBuses} disposer remains valid: later
 * unregister teardown is idempotent once types are cleared.
 *
 * @template TCommand
 * @template TQuery
 * @template TEvent
 * @param {object} instance - wired component instance
 * @param {RuntimeBusesBundle<TCommand, TQuery, TEvent>} buses - runtime bus bundle
 * @param {{ commandTypes?: ReadonlySet<string>; queryTypes?: ReadonlySet<string> }} [onlyTypes]
 *   optional filter; omit to release every exclusive type declared on the instance
 * @returns {void}
 */
export function releaseExclusiveRuntimeBusHandlers<
  TCommand extends RuntimeCommand,
  TQuery extends RuntimeQuery,
  TEvent extends RuntimeEvent,
> (
  instance: object,
  buses: RuntimeBusesBundle<TCommand, TQuery, TEvent>,
  onlyTypes?: {
    commandTypes?: ReadonlySet<string>;
    queryTypes?: ReadonlySet<string>;
  },
): void {
  const leafCtor = instance.constructor as Function;
  const commandTypes = new Set<string>();
  const queryTypes = new Set<string>();

  for (const ctor of getConstructorChainLeafFirst(leafCtor)) {
    for (const { type } of getHandlerEntries(ctor, ON_COMMAND_ENTRIES)) {
      if (
        onlyTypes?.commandTypes === undefined ||
        onlyTypes.commandTypes.has(type)
      ) {
        commandTypes.add(type);
      }
    }
    for (const { type } of getHandlerEntries(ctor, ON_QUERY_ENTRIES)) {
      if (
        onlyTypes?.queryTypes === undefined ||
        onlyTypes.queryTypes.has(type)
      ) {
        queryTypes.add(type);
      }
    }
  }

  for (const type of commandTypes) {
    buses.commandBus.unregister(type as TCommand['type']);
  }
  for (const type of queryTypes) {
    buses.queryBus.unregister(type as TQuery['type']);
  }
}

/**
 * Calls {@link wireRuntimeBuses} only if the constructor chain has relevant decorators.
 *
 * @template TCommand
 * @template TQuery
 * @template TEvent
 * @param {object} instance - instance
 * @param {RuntimeBusesBundle<TCommand, TQuery, TEvent>} buses - buses
 * @returns {(() => void) | null} disposer or null if wiring is not needed
 */
export function wireRuntimeBusesIfDecorated<
  TCommand extends RuntimeCommand,
  TQuery extends RuntimeQuery,
  TEvent extends RuntimeEvent,
> (
  instance: object,
  buses: RuntimeBusesBundle<TCommand, TQuery, TEvent>
): (() => void) | null {
  if (!instanceUsesRuntimeBusDecorators(instance)) {
    return null;
  }

  return wireRuntimeBuses(instance, buses);
}

function assignBusProps (
  instance: object,
  ctor: Function,
  metaKey: string,
  value: unknown
): void {
  const keys = getStringPropKeys(ctor, metaKey);
  const record = instance as Record<string, unknown>;
  for (const key of keys) {
    // defineProperty — `record[key] =` invokes the Object.prototype `__proto__`
    // setter when a decorated field is named `__proto__`, replacing the
    // instance [[Prototype]] with the bus and dropping Component methods.
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
}

/**
 * Unwinds disposers in reverse order, continuing even if one throws.
 * Returns primary error (if any) and optional cleanup errors.
 *
 * @param {Array<() => void>} disposers - disposers in registration order
 * @returns {{ primaryError?: Error; cleanupErrors: Error[] }} unwinding result
 */
function unwindDisposers (disposers: Array<() => void>): { primaryError?: Error; cleanupErrors: Error[] } {
  const cleanupErrors: Error[] = [];
  for (let i = disposers.length - 1; i >= 0; i -= 1) {
    try {
      disposers[i]();
    } catch (err) {
      cleanupErrors.push(err instanceof Error ? err : new Error(String(err)));
    }
  }
  return { cleanupErrors };
}

/**
 * Injects buses into `@Use*Bus` fields and registers `@OnCommand` / `@OnQuery` / `@OnEvent` handlers.
 * Registration is transactional: if a handler registration or validation throws, all prior registrations
 * are unwound in reverse order and the wiring error is rethrown. The returned disposer is idempotent
 * and continues cleanup even if an individual disposer throws.
 *
 * EventBus fan-out: every distinct `@OnEvent` method for the same type is subscribed (unlike
 * Command/Query last-write-wins). Delivery itself uses {@link EventBus.publish} handler snapshots.
 *
 * @template TCommand
 * @template TQuery
 * @template TEvent
 * @param {object} instance - class instance with decorator metadata
 * @param {RuntimeBusesBundle<TCommand, TQuery, TEvent>} buses - bus bundle
 * @returns {() => void} disposer: removes registrations and subscriptions created by this call
 */
export function wireRuntimeBuses<
  TCommand extends RuntimeCommand,
  TQuery extends RuntimeQuery,
  TEvent extends RuntimeEvent,
> (
  instance: object,
  buses: RuntimeBusesBundle<TCommand, TQuery, TEvent>
): () => void {
  const leafCtor = instance.constructor as Function;
  const ctorChain = getConstructorChainLeafFirst(leafCtor);
  const disposers: Array<() => void> = [];

  try {
    // Base → leaf: last assign wins when field names collide.
    for (let i = ctorChain.length - 1; i >= 0; i -= 1) {
      const ctor = ctorChain[i] as Function;
      assignBusProps(instance, ctor, USE_COMMAND_BUS_PROPS, buses.commandBus);
      assignBusProps(instance, ctor, USE_QUERY_BUS_PROPS, buses.queryBus);
      assignBusProps(instance, ctor, USE_EVENT_BUS_PROPS, buses.eventBus);
    }

    const mergedCommand = new Map<string, string>();
    const mergedQuery = new Map<string, string>();
    // EventBus is fan-out: keep every distinct method for a type (unlike Command/Query).
    const mergedEvent = new Map<string, string[]>();

    for (let i = ctorChain.length - 1; i >= 0; i -= 1) {
      const ctor = ctorChain[i] as Function;
      for (const { type, method } of getHandlerEntries(ctor, ON_COMMAND_ENTRIES)) {
        mergedCommand.set(type, method);
      }
      for (const { type, method } of getHandlerEntries(ctor, ON_QUERY_ENTRIES)) {
        mergedQuery.set(type, method);
      }
      for (const { type, method } of getHandlerEntries(ctor, ON_EVENT_ENTRIES)) {
        const existing = mergedEvent.get(type);
        if (typeof existing === 'undefined') {
          mergedEvent.set(type, [method]);
        } else if (!existing.includes(method)) {
          existing.push(method);
        }
      }
    }

    const record = instance as Record<string, unknown>;

    for (const [type, method] of mergedCommand) {
      const raw = record[method];
      if (typeof raw !== 'function') {
        throw new Error(`wireRuntimeBuses: OnCommand handler is not a function: ${method}`);
      }
      const handler: CommandHandler<TCommand, unknown> = (command) => {
        return raw.call(instance, command) as ReturnType<CommandHandler<TCommand, unknown>>;
      };
      disposers.push(buses.commandBus.register(type as TCommand['type'], handler));
    }

    for (const [type, method] of mergedQuery) {
      const raw = record[method];
      if (typeof raw !== 'function') {
        throw new Error(`wireRuntimeBuses: OnQuery handler is not a function: ${method}`);
      }
      const handler: QueryHandler<TQuery, unknown> = (query) => {
        return raw.call(instance, query) as ReturnType<QueryHandler<TQuery, unknown>>;
      };
      disposers.push(buses.queryBus.register(type as TQuery['type'], handler));
    }

    for (const [type, methods] of mergedEvent) {
      for (const method of methods) {
        const raw = record[method];
        if (typeof raw !== 'function') {
          throw new Error(`wireRuntimeBuses: OnEvent handler is not a function: ${method}`);
        }
        const handler: EventHandler<TEvent> = (event) => {
          raw.call(instance, event);
        };
        disposers.push(buses.eventBus.subscribe(type as TEvent['type'], handler));
      }
    }
  } catch (wiringError) {
    const { cleanupErrors } = unwindDisposers(disposers);
    const primary = wiringError instanceof Error ? wiringError : new Error(String(wiringError));
    if (cleanupErrors.length > 0) {
      (primary as Error & { cleanupErrors?: Error[] }).cleanupErrors = cleanupErrors;
    }
    throw primary;
  }

  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;

    const { cleanupErrors } = unwindDisposers(disposers);
    if (cleanupErrors.length > 0) {
      const aggregateError = new Error(
        `wireRuntimeBuses: disposer cleanup encountered ${cleanupErrors.length} error(s)`
      ) as Error & { cleanupErrors: Error[] };
      aggregateError.cleanupErrors = cleanupErrors;
      throw aggregateError;
    }
  };
}

/**
 * Wires multiple instances to one bus bundle: calls {@link wireRuntimeBuses} for each.
 * Order in `instances` defines wiring order; the disposer unregisters in reverse order.
 * Wiring is transactional: if a later instance fails to wire, all earlier instances are unwound
 * in reverse order. The returned disposer is idempotent and continues cleanup even if an
 * individual disposer throws.
 *
 * @template TCommand
 * @template TQuery
 * @template TEvent
 * @param buses - shared {@link RuntimeBusesBundle} (including the three fields from `BootstrapHandle.runtime`)
 * @param instances - instances with `@Use*Bus` / `@OnCommand` / `@OnQuery` / `@OnEvent` decorators
 * @returns {() => void} single disposer for all wiring calls
 */
export function wireRuntimeBusesAll<
  TCommand extends RuntimeCommand,
  TQuery extends RuntimeQuery,
  TEvent extends RuntimeEvent,
> (
  buses: RuntimeBusesBundle<TCommand, TQuery, TEvent>,
  instances: readonly object[]
): () => void {
  const disposers: Array<() => void> = [];
  try {
    for (let i = 0; i < instances.length; i += 1) {
      const instance = instances[i];
      disposers.push(wireRuntimeBuses(instance, buses));
    }
  } catch (wiringError) {
    const { cleanupErrors } = unwindDisposers(disposers);
    const primary = wiringError instanceof Error ? wiringError : new Error(String(wiringError));
    if (cleanupErrors.length > 0) {
      (primary as Error & { cleanupErrors?: Error[] }).cleanupErrors = cleanupErrors;
    }
    throw primary;
  }

  let disposed = false;
  return () => {
    if (disposed) {
      return;
    }
    disposed = true;

    const { cleanupErrors } = unwindDisposers(disposers);
    if (cleanupErrors.length > 0) {
      const aggregateError = new Error(
        `wireRuntimeBusesAll: disposer cleanup encountered ${cleanupErrors.length} error(s)`
      ) as Error & { cleanupErrors: Error[] };
      aggregateError.cleanupErrors = cleanupErrors;
      throw aggregateError;
    }
  };
}
