/**
 * Residual: any-handlers were snapshotted only after typed handlers ran,
 * so a typed handler that unsubscribed an any-handler could skip it for the
 * current event.
 */
import { EventBus } from 'Effectable';
import type { RuntimeEvent } from 'Effectable';

type E = RuntimeEvent<'GO', undefined>;

describe('EventBus publish cross-set snapshot', () => {
  test('typed handler unsubscribing any mid-publish still delivers to that any once', () => {
    const bus = new EventBus<E>();
    const seen: string[] = [];

    const anyHandler = (e: E): void => {
      seen.push(`any:${e.type}`);
    };
    const unsubAny = bus.subscribeAll(anyHandler);

    bus.subscribe('GO', (): void => {
      seen.push('typed');
      unsubAny();
    });

    bus.publish({ type: 'GO', payload: undefined });
    expect(seen).toEqual(['typed', 'any:GO']);
  });
});
