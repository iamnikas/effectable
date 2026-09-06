/**
 * Regression: mapStateToProps throw during the sync preamble of an async user
 * onMount used to make connect throw synchronously after suppressing the
 * onMount Promise. GraphRuntime then fail-stopped / unmounted while the user
 * onMount body was still awaiting — continuation after await raced teardown.
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

describe('connect async onMount + mapState throw teardown race', () => {
  it('awaits user onMount before GraphRuntime teardown (no post-unmount continuation)', async () => {
    const store = createStore(
      (
        s: { n: number; bad?: boolean } | undefined,
        a: { type: string },
      ): { n: number; bad?: boolean } => {
        if (typeof s === 'undefined') {
          return { n: 0 };
        }
        if (a.type === 'BAD') {
          return { n: s.n, bad: true };
        }
        return s;
      },
      { n: 0 },
    );

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const events: string[] = [];

    class Svc extends Component<{ n?: number }, Record<string, never>> {
      public override async onMount (): Promise<void> {
        events.push('user-mount-start');
        try {
          store.dispatch({ type: 'BAD' });
        } catch {
          events.push('dispatch-threw');
        }
        events.push('user-mount-await');
        await gate;
        events.push('user-mount-after-await');
      }

      public override onUnmount (): void {
        events.push('user-unmount');
      }

      public override compose (): null {
        return null;
      }
    }

    const Connected = connect(store, (s: { n: number; bad?: boolean }) => {
      if (s.bad === true) {
        throw new Error('mapState boom');
      }
      return { n: s.n };
    })(Svc);

    class Root extends Component {
      public override compose (): VirtualServiceNode {
        return h(Connected as unknown as typeof Svc, {});
      }
    }

    const mountPromise = GraphRuntime.mount(h(Root, {}));

    // Let connect park on the user onMount await, then release.
    await new Promise((r) => setImmediate(r));
    expect(events).toContain('user-mount-await');
    expect(events).not.toContain('user-unmount');

    release();
    await expect(mountPromise).rejects.toThrow('mapState boom');

    expect(events).toEqual([
      'user-mount-start',
      'user-mount-await',
      'user-mount-after-await',
      'user-unmount',
    ]);

    store.destroy();
  });
});
