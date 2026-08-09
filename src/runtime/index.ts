/**
 * Re-export of Effectable runtime primitives.
 *
 * @module Effectable/runtime
 */

export {
  HandleRegistry,
  forwardRef,
  UseRef,
  UseImperativeHandle,
} from './HandleRegistry';
export { CommandBus } from './CommandBus';
export { QueryBus } from './QueryBus';
export { EventBus } from './EventBus';
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
} from './types';
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
} from './BusDecorators';
export type { RuntimeBusesBundle } from './BusDecorators';
