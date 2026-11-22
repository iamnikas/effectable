/**
 * Regression: awaiting reconcile/unmount from onMount while a graph op is in-flight
 * used to deadlock the single operation queue. Reentrant calls must reject promptly;
 * unmount must still schedule teardown. Concurrent external callers must still enqueue.
 */
import { Component, GraphRuntime, h } from '../src';
import type { VirtualServiceNode } from '../src';

jest.setTimeout(15_000);

let runtimeHolder: GraphRuntime | null = null;

class ReentrantReconcileChild extends Component<Record<string, never>, Record<string, never>> {
  public static reached = false;
  public static nestedError: unknown = null;

  constructor (props: Record<string, never>) {
    super(props);
    this.state = {};
  }

  public override async onMount (): Promise<void> {
    ReentrantReconcileChild.reached = true;
    const rt = runtimeHolder;
    if (rt === null) {
      throw new Error('runtimeHolder not set');
    }
    try {
      await rt.reconcile(h(SpawnReconcileHost, { spawn: false }));
    } catch (err: unknown) {
      ReentrantReconcileChild.nestedError = err;
      throw err;
    }
  }
}

class ReentrantUnmountChild extends Component<Record<string, never>, Record<string, never>> {
  public static reached = false;
  public static nestedError: unknown = null;
  public static unmountCount = 0;

  constructor (props: Record<string, never>) {
    super(props);
    this.state = {};
  }

  public override async onMount (): Promise<void> {
    ReentrantUnmountChild.reached = true;
    const rt = runtimeHolder;
    if (rt === null) {
      throw new Error('runtimeHolder not set');
    }
    try {
      await rt.unmount();
    } catch (err: unknown) {
      ReentrantUnmountChild.nestedError = err;
      // Swallow so PLACE can finish; deferred unmount should still run.
    }
  }

  public override onUnmount (): void {
    ReentrantUnmountChild.unmountCount += 1;
  }
}

class SpawnReconcileHost extends Component<Record<string, never>, { spawn: boolean }> {
  constructor (props: { spawn: boolean }) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode | null {
    return this.props.spawn ? h(ReentrantReconcileChild, {}) : null;
  }
}

class SpawnUnmountHost extends Component<Record<string, never>, { spawn: boolean }> {
  constructor (props: { spawn: boolean }) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode | null {
    return this.props.spawn ? h(ReentrantUnmountChild, {}) : null;
  }
}

describe('GraphRuntime reentrant op-queue from onMount', () => {
  beforeEach(() => {
    runtimeHolder = null;
    ReentrantReconcileChild.reached = false;
    ReentrantReconcileChild.nestedError = null;
    ReentrantUnmountChild.reached = false;
    ReentrantUnmountChild.nestedError = null;
    ReentrantUnmountChild.unmountCount = 0;
  });

  it('await reconcile() from child onMount rejects instead of deadlocking', async () => {
    const runtime = await GraphRuntime.mount(h(SpawnReconcileHost, { spawn: false }));
    runtimeHolder = runtime;

    await expect(
      runtime.reconcile(h(SpawnReconcileHost, { spawn: true })),
    ).rejects.toThrow(/deadlock the operation queue|in-flight graph operation/);

    expect(ReentrantReconcileChild.reached).toBe(true);
    expect(String(ReentrantReconcileChild.nestedError)).toMatch(
      /deadlock the operation queue|in-flight graph operation/,
    );

    await runtime.unmount();
  });

  it('await unmount() from child onMount rejects awaiter but still tears down', async () => {
    const runtime = await GraphRuntime.mount(h(SpawnUnmountHost, { spawn: false }));
    runtimeHolder = runtime;

    // Outer reconcile should complete (onMount swallows the reentrant reject).
    await runtime.reconcile(h(SpawnUnmountHost, { spawn: true }));

    expect(ReentrantUnmountChild.reached).toBe(true);
    expect(String(ReentrantUnmountChild.nestedError)).toMatch(
      /cannot be awaited from inside an in-flight|teardown was scheduled/,
    );

    // Deferred unmount scheduled from onMount must finish.
    await expect(runtime.unmount()).resolves.toBeUndefined();
    expect(runtime.isActive()).toBe(false);
    expect(ReentrantUnmountChild.unmountCount).toBeGreaterThanOrEqual(1);
  });
});
