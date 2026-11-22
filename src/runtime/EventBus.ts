/**
 * Lightweight event bus implementation.
 *
 * Delivery contract: each `publish` snapshots typed and any-handlers before invoke so a
 * subscriber that unsubscribes mid-delivery cannot silently skip a not-yet-called handler
 * for the current event. Combined with `wireRuntimeBuses` EventBus fan-out (every distinct
 * `@OnEvent` method for a type receives the event), this is the public delivery guarantee.
 *
 * @module Effectable/runtime/EventBus
 */

import type { EventHandler, RuntimeEvent } from './types';

/**
 * Event bus with per-type and global subscriptions.
 *
 * {@link EventBus.publish} uses handler snapshots; see the module overview for the delivery contract.
 */
export class EventBus<TEvent extends RuntimeEvent = RuntimeEvent> {
  private readonly handlersByType = new Map<string, Set<EventHandler<TEvent>>>();
  private readonly anyHandlers = new Set<EventHandler<TEvent>>();
  /**
   * Monotonic subscription ids. Disposers from `subscribe` / `subscribeAll` only remove
   * the handler when the id still matches — so unsubscribe/clear + re-subscribe of the
   * *same function* is not torn down by a stale disposer (HandleRegistry contract).
   */
  private readonly typedSubscriptionIds = new Map<string, Map<EventHandler<TEvent>, number>>();
  private readonly anySubscriptionIds = new Map<EventHandler<TEvent>, number>();
  private nextSubscriptionId = 1;

  /**
   * Publishes an event to all matching subscribers.
   *
   * Snapshots both the typed-handler set and the any-handler set before invoke. Mid-publish
   * unsubscribe cannot drop a not-yet-called handler for this event; any-handlers are
   * snapshotted before typed handlers run so a typed handler cannot remove an any-handler
   * from the current delivery.
   *
   * @param {TEvent} event - runtime event
   * @returns {void}
   */
  public publish (event: TEvent): void {
    // Snapshot both sets before invoke so unsubscribe of a not-yet-called handler
    // during this publish cannot silently skip that handler for the current event.
    // Any-handlers must be snapshotted before typed handlers run: a typed handler
    // that unsubscribes an any-handler would otherwise drop it for this event.
    const typedHandlers = this.handlersByType.get(event.type);
    const typedSnapshot = typeof typedHandlers === 'undefined'
      ? null
      : [...typedHandlers];
    const anySnapshot = [...this.anyHandlers];

    if (typedSnapshot !== null) {
      for (const handler of typedSnapshot) {
        handler(event);
      }
    }

    for (const handler of anySnapshot) {
      handler(event);
    }
  }

  /**
   * Subscribes a handler to the given event type only.
   *
   * @param {TEvent['type']} eventType - event type
   * @param {EventHandler<TEvent>} handler - event handler
   * @returns {() => void} unsubscribe function; no-op if this subscription was superseded
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

    const subscriptionId = this.nextSubscriptionId;
    this.nextSubscriptionId += 1;
    let idsForType = this.typedSubscriptionIds.get(eventType);
    if (typeof idsForType === 'undefined') {
      idsForType = new Map<EventHandler<TEvent>, number>();
      this.typedSubscriptionIds.set(eventType, idsForType);
    }
    idsForType.set(handler, subscriptionId);

    return () => {
      if (this.typedSubscriptionIds.get(eventType)?.get(handler) === subscriptionId) {
        this.unsubscribe(eventType, handler);
      }
    };
  }

  /**
   * Subscribes a handler to all events on the bus.
   *
   * @param {EventHandler<TEvent>} handler - event handler
   * @returns {() => void} unsubscribe function; no-op if this subscription was superseded
   */
  public subscribeAll (handler: EventHandler<TEvent>): () => void {
    this.anyHandlers.add(handler);

    const subscriptionId = this.nextSubscriptionId;
    this.nextSubscriptionId += 1;
    this.anySubscriptionIds.set(handler, subscriptionId);

    return () => {
      if (this.anySubscriptionIds.get(handler) === subscriptionId) {
        this.anyHandlers.delete(handler);
        this.anySubscriptionIds.delete(handler);
      }
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
    const idsForType = this.typedSubscriptionIds.get(eventType);
    if (typeof idsForType !== 'undefined') {
      idsForType.delete(handler);
      if (idsForType.size === 0) {
        this.typedSubscriptionIds.delete(eventType);
      }
    }
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
    this.typedSubscriptionIds.clear();
    this.anySubscriptionIds.clear();
  }
}
