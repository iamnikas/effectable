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
   * Registers a query handler.
   *
   * @param {TQuery['type']} queryType - query type
   * @param {QueryHandler<TQuery, TResult>} handler - query handler
   * @returns {() => void} unregister function
   * @throws {Error} if a handler is already registered
   */
  public register<TResult> (
    queryType: TQuery['type'],
    handler: QueryHandler<TQuery, TResult>
  ): () => void {
    if (this.handlers.has(queryType)) {
      throw new Error(`Query handler is already registered: ${queryType}`);
    }

    this.handlers.set(queryType, handler as QueryHandler<TQuery, unknown>);
    return () => {
      this.unregister(queryType);
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
  }

  /**
   * Clears all registered handlers.
   *
   * @returns {void}
   */
  public clear (): void {
    this.handlers.clear();
  }
}
