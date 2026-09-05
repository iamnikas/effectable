/**
 * Regression: async onMount returns a Promise while a nested mapState failure
 * has already set syncSubscribeError. Post-subscribe must return
 * pendingMountResult (not throw sync) or the Promise is orphaned.
 *
 * @module Effectable/connect/connect.async-mount-mapstate-throw.test
 */
import { Component, connect, createStore } from 'Effectable';

describe('connect async onMount + mapState throw', () => {
  it('returns pendingMountResult so mapState failure rejects the mount Promise', async () => {
    const store = createStore((s: { n: number; bad?: boolean } | undefined, a: { type: string }): { n: number; bad?: boolean } => {
      if (typeof s === 'undefined') return { n: 0 };
      if (a.type === 'BAD') return { n: s.n, bad: true };
      return s;
    }, { n: 0 });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });

      class Svc extends Component<{ n?: number }, Record<string, never>> {
        public override async onMount (): Promise<void> {
          try {
            store.dispatch({ type: 'BAD' });
          } catch {
            // RxJS may rethrow projector errors to the dispatch caller; swallow so
            // this async onMount still returns a Promise to connect.
          }
          await gate;
        }
      }

      const Connected = connect(store, (s: { n: number; bad?: boolean }) => {
        if (s.bad === true) {
          throw new Error('mapState boom');
        }
        return { n: s.n };
      })(Svc);

      const inst = new Connected({});
      // Must return a Promise (not throw sync after subscribe).
      const mountResult = inst.onMount!();
      expect(mountResult).toBeInstanceOf(Promise);

      const settled = Promise.resolve(mountResult).then(
        () => 'fulfilled' as const,
        (err: unknown) => (err instanceof Error ? err.message : String(err)),
      );

      await new Promise((r) => setImmediate(r));
      release();
      const outcome = await settled;
      expect(outcome).toBe('mapState boom');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      store.destroy();
    }
  });
});
