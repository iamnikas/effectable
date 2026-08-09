/**
 * Lightweight command bus implementation.
 *
 * @module Effectable/runtime/CommandBus
 */

import type { CommandHandler, RuntimeCommand } from './types';

/**
 * Command bus with a single handler per command type.
 */
export class CommandBus<TCommand extends RuntimeCommand = RuntimeCommand> {
  private readonly handlers = new Map<string, CommandHandler<TCommand, unknown>>();

  /**
   * Registers a command handler.
   *
   * @param {TCommand['type']} commandType - command type
   * @param {CommandHandler<TCommand, TResult>} handler - command handler
   * @returns {() => void} unregister function
   * @throws {Error} if a handler is already registered
   */
  public register<TResult> (
    commandType: TCommand['type'],
    handler: CommandHandler<TCommand, TResult>
  ): () => void {
    if (this.handlers.has(commandType)) {
      throw new Error(`Command handler is already registered: ${commandType}`);
    }

    this.handlers.set(commandType, handler as CommandHandler<TCommand, unknown>);
    return () => {
      this.unregister(commandType);
    };
  }

  /**
   * Executes a command through the registered handler.
   *
   * @param {TCommand} command - command
   * @returns {Promise<TResult>} command handling result
   * @throws {Error} if no handler is found
   */
  public async execute<TResult> (command: TCommand): Promise<TResult> {
    const handler = this.handlers.get(command.type);
    if (typeof handler === 'undefined') {
      throw new Error(`Command handler is not registered: ${command.type}`);
    }

    const result = await handler(command);
    return result as TResult;
  }

  /**
   * Unregisters a command handler.
   *
   * @param {TCommand['type']} commandType - command type
   * @returns {void}
   */
  public unregister (commandType: TCommand['type']): void {
    this.handlers.delete(commandType);
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
