/**
 * Lightweight query bus implementation.
 *
 * @module Effectable/runtime/QueryBus
 */

import type { QueryHandler, RuntimeQuery } from './types';

/**
 * Query bus with a single handler per query type.
 */
export class QueryBus<TQuery extends RuntimeQuery = RuntimeQuery> {
  private readonly handlers = new Map<string, QueryHandler<TQuery, unknown>>();
  /**
   * Monotonic registration id per query type. Disposers capture the id from their
   * `register` call and only delete when it still matches — so re-registering the
   * *same handler function* after unregister/clear cannot be torn down by a stale
   * disposer from the previous registration generation (same contract as HandleRegistry).
   */
  private readonly registrationIds = new Map<string, number>();
  private nextRegistrationId = 1;

  /**
   * Registers a query handler.
   *
   * @param {TQuery['type']} queryType - query type
   * @param {QueryHandler<TQuery, TResult>} handler - query handler
   * @returns {() => void} unregister function; no-op if this registration was superseded
   *   (including re-register of the same function reference after unregister/clear)
   * @throws {Error} if a handler is already registered
   */
  public register<TResult> (
    queryType: TQuery['type'],
    handler: QueryHandler<TQuery, TResult>
  ): () => void {
    if (this.handlers.has(queryType)) {
      throw new Error(`Query handler is already registered: ${queryType}`);
    }

    const registered = handler as QueryHandler<TQuery, unknown>;
    const registrationId = this.nextRegistrationId;
    this.nextRegistrationId += 1;
    this.handlers.set(queryType, registered);
    this.registrationIds.set(queryType, registrationId);
    return () => {
      if (this.registrationIds.get(queryType) === registrationId) {
        this.handlers.delete(queryType);
        this.registrationIds.delete(queryType);
      }
    };
  }

  /**
   * Executes a query through the registered handler.
   *
   * @param {TQuery} query - query
   * @returns {Promise<TResult>} query execution result
   * @throws {Error} if no handler is found
   */
  public async execute<TResult> (query: TQuery): Promise<TResult> {
    const handler = this.handlers.get(query.type);
    if (typeof handler === 'undefined') {
      throw new Error(`Query handler is not registered: ${query.type}`);
    }

    const result = await handler(query);
    return result as TResult;
  }

  /**
   * Unregisters a query handler.
   *
   * @param {TQuery['type']} queryType - query type
   * @returns {void}
   */
  public unregister (queryType: TQuery['type']): void {
    this.handlers.delete(queryType);
    this.registrationIds.delete(queryType);
  }

  /**
   * Clears all registered handlers.
   *
   * @returns {void}
   */
  public clear (): void {
    this.handlers.clear();
    this.registrationIds.clear();
  }
}
