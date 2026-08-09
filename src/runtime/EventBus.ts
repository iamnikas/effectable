/**
 * Lightweight event bus implementation.
 *
 * @module Effectable/runtime/EventBus
 */

import type { EventHandler, RuntimeEvent } from './types';

/**
 * Event bus with per-type and global subscriptions.
 */
export class EventBus<TEvent extends RuntimeEvent = RuntimeEvent> {
  private readonly handlersByType = new Map<string, Set<EventHandler<TEvent>>>();
  private readonly anyHandlers = new Set<EventHandler<TEvent>>();

  /**
   * Publishes an event to all matching subscribers.
   *
   * @param {TEvent} event - runtime event
   * @returns {void}
   */
  public publish (event: TEvent): void {
    const typedHandlers = this.handlersByType.get(event.type);
    if (typeof typedHandlers !== 'undefined') {
      for (const handler of typedHandlers) {
        handler(event);
      }
    }

    for (const handler of this.anyHandlers) {
      handler(event);
    }
  }

  /**
   * Subscribes a handler to the given event type only.
   *
   * @param {TEvent['type']} eventType - event type
   * @param {EventHandler<TEvent>} handler - event handler
   * @returns {() => void} unsubscribe function
   */
  public subscribe (
    eventType: TEvent['type'],
    handler: EventHandler<TEvent>
  ): () => void {
    const current = this.handlersByType.get(eventType);
    const handlers = typeof current === 'undefined'
      ? new Set<EventHandler<TEvent>>()
      : current;

    handlers.add(handler);
    this.handlersByType.set(eventType, handlers);

    return () => {
      this.unsubscribe(eventType, handler);
    };
  }

  /**
   * Subscribes a handler to all events on the bus.
   *
   * @param {EventHandler<TEvent>} handler - event handler
   * @returns {() => void} unsubscribe function
   */
  public subscribeAll (handler: EventHandler<TEvent>): () => void {
    this.anyHandlers.add(handler);
    return () => {
      this.anyHandlers.delete(handler);
    };
  }

  /**
   * Unsubscribes a handler from a specific event type.
   *
   * @param {TEvent['type']} eventType - event type
   * @param {EventHandler<TEvent>} handler - event handler
   * @returns {void}
   */
  public unsubscribe (
    eventType: TEvent['type'],
    handler: EventHandler<TEvent>
  ): void {
    const handlers = this.handlersByType.get(eventType);
    if (typeof handlers === 'undefined') {
      return;
    }

    handlers.delete(handler);
    if (handlers.size === 0) {
      this.handlersByType.delete(eventType);
    }
  }

  /**
   * Clears all subscriptions.
   *
   * @returns {void}
   */
  public clear (): void {
    this.handlersByType.clear();
    this.anyHandlers.clear();
  }
}
