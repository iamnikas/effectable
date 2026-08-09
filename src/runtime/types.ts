/**
 * Shared types for Effectable runtime primitives.
 *
 * @module Effectable/runtime/types
 */

/**
 * Base shape of a runtime command.
 */
export interface RuntimeCommand<TType extends string = string, TPayload = unknown> {
  type: TType;
  payload: TPayload;
}

/**
 * Base shape of a runtime query.
 */
export interface RuntimeQuery<TType extends string = string, TPayload = unknown> {
  type: TType;
  payload: TPayload;
}

/**
 * Base shape of a runtime event.
 */
export interface RuntimeEvent<TType extends string = string, TPayload = unknown> {
  type: TType;
  payload: TPayload;
}

/**
 * Generic resource dispose function.
 */
export type RuntimeDispose = () => void;

/**
 * Command handler.
 */
export type CommandHandler<TCommand extends RuntimeCommand = RuntimeCommand, TResult = void> =
  (command: TCommand) => TResult | Promise<TResult>;

/**
 * Query handler.
 */
export type QueryHandler<TQuery extends RuntimeQuery = RuntimeQuery, TResult = unknown> =
  (query: TQuery) => TResult | Promise<TResult>;

/**
 * Event handler.
 */
export type EventHandler<TEvent extends RuntimeEvent = RuntimeEvent> =
  (event: TEvent) => void;

/**
 * Command-handler contract for a runtime bus.
 */
export interface RuntimeCommandHandlerContract<
  TCommand extends RuntimeCommand = RuntimeCommand,
  TResult = unknown,
> {
  /**
   * Returns the supported command type.
   *
   * @returns {TCommand['type']} string command type
   */
  getCommandType(): TCommand['type'];

  /**
   * Executes command handling.
   *
   * @param {TCommand} command - incoming command
   * @returns {TResult | Promise<TResult>} handling result
   */
  execute(command: TCommand): TResult | Promise<TResult>;
}

/**
 * Query-handler contract for a runtime bus.
 */
export interface RuntimeQueryHandlerContract<
  TQuery extends RuntimeQuery = RuntimeQuery,
  TResult = unknown,
> {
  /**
   * Returns the supported query type.
   *
   * @returns {TQuery['type']} string query type
   */
  getQueryType(): TQuery['type'];

  /**
   * Executes query handling.
   *
   * @param {TQuery} query - incoming query
   * @returns {TResult | Promise<TResult>} handling result
   */
  execute(query: TQuery): TResult | Promise<TResult>;
}
