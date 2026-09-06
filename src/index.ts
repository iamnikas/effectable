/**
 * Effectable entry point: bootstrap, store, component, connect, runtime.
 * Re-exports bootstrap, store, component, connect, and runtime for a single entry
 * (Effectable or selective imports).
 *
 * Note on name conflicts:
 * - UseRef and UseImperativeHandle from runtime/HandleRegistry are for registering
 *   imperative handles in HandleRegistry (legacy mechanism).
 * - UseRef and UseImperativeHandle from component/refs are for GraphRuntime
 *   (fiber-based declarative tree, mounted lifecycle).
 * To resolve the conflict, the runtime versions are exported with the Handle* alias.
 *
 * @module Effectable
 */

export * from './bootstrap';
export * from './store';
export * from './component';
export * from './connect';

// runtime: export with aliases for UseRef/UseImperativeHandle to avoid conflict with component/refs
export {
  HandleRegistry,
  forwardRef,
  UseRef as HandleRegistryUseRef,
  UseImperativeHandle as HandleRegistryUseImperativeHandle,
} from './runtime/HandleRegistry';
export { CommandBus } from './runtime/CommandBus';
export { QueryBus } from './runtime/QueryBus';
export { EventBus } from './runtime/EventBus';
export type {
  RuntimeCommand,
  RuntimeQuery,
  RuntimeEvent,
  RuntimeDispose,
  CommandHandler,
  QueryHandler,
  EventHandler,
  RuntimeCommandHandlerContract,
  RuntimeQueryHandlerContract,
} from './runtime/types';
export {
  UseCommandBus,
  UseQueryBus,
  UseEventBus,
  OnCommand,
  OnQuery,
  OnEvent,
  createRuntimeBuses,
  wireRuntimeBuses,
  wireRuntimeBusesIfDecorated,
  instanceUsesRuntimeBusDecorators,
  wireRuntimeBusesAll,
} from './runtime/BusDecorators';
export type { RuntimeBusesBundle, RuntimeBusWiringDisposer } from './runtime/BusDecorators';
