/**
 * Residual of #123: the first reentrant unmount from onMount correctly scheduled
 * deferred teardown and rejected the awaiter, but a *second* await unmount() from
 * inside the same in-flight op (sibling PLACE onMount, or retry after catch) joined
 * cachedUnmountPromise and deadlocked the operation queue.
 */
import { Component, GraphRuntime, h } from '../src';
import type { VirtualServiceNode } from '../src';

jest.setTimeout(15_000);

let runtimeHolder: GraphRuntime | null = null;

class FirstUnmountChild extends Component<Record<string, never>, Record<string, never>> {
  public static reached = false;

  constructor (props: Record<string, never>) {
    super(props);
    this.state = {};
  }

  public override async onMount (): Promise<void> {
    FirstUnmountChild.reached = true;
    const rt = runtimeHolder;
    if (rt === null) {
      throw new Error('runtimeHolder not set');
    }
    try {
      await rt.unmount();
    } catch {
      // Expected reentrancy reject; teardown is scheduled on the op queue.
    }
  }
}

class SecondUnmountChild extends Component<Record<string, never>, Record<string, never>> {
  public static reached = false;
  public static nestedError: unknown = null;

  constructor (props: Record<string, never>) {
    super(props);
    this.state = {};
  }

  public override async onMount (): Promise<void> {
    SecondUnmountChild.reached = true;
    const rt = runtimeHolder;
    if (rt === null) {
      throw new Error('runtimeHolder not set');
    }
    try {
      // Before the fix this joined cachedUnmountPromise and never settled.
      await rt.unmount();
    } catch (err: unknown) {
      SecondUnmountChild.nestedError = err;
    }
  }
}

class RetryUnmountChild extends Component<Record<string, never>, Record<string, never>> {
  public static reached = false;
  public static secondError: unknown = null;

  constructor (props: Record<string, never>) {
    super(props);
    this.state = {};
  }

  public override async onMount (): Promise<void> {
    RetryUnmountChild.reached = true;
    const rt = runtimeHolder;
    if (rt === null) {
      throw new Error('runtimeHolder not set');
    }
    try {
      await rt.unmount();
    } catch {
      // swallow first reject
    }
    try {
      await rt.unmount();
    } catch (err: unknown) {
      RetryUnmountChild.secondError = err;
    }
  }
}

class SiblingHost extends Component<Record<string, never>, { spawn: boolean }> {
  constructor (props: { spawn: boolean }) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode | VirtualServiceNode[] | null {
    if (!this.props.spawn) {
      return null;
    }
    return [
      h(FirstUnmountChild, {}, 'a'),
      h(SecondUnmountChild, {}, 'b'),
    ];
  }
}

class RetryHost extends Component<Record<string, never>, { spawn: boolean }> {
  constructor (props: { spawn: boolean }) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode | null {
    return this.props.spawn ? h(RetryUnmountChild, {}) : null;
  }
}

describe('GraphRuntime reentrant unmount must not join cached promise', () => {
  beforeEach(() => {
    runtimeHolder = null;
    FirstUnmountChild.reached = false;
    SecondUnmountChild.reached = false;
    SecondUnmountChild.nestedError = null;
    RetryUnmountChild.reached = false;
    RetryUnmountChild.secondError = null;
  });

  it('sibling onMount await unmount after peer scheduled teardown rejects (no deadlock)', async () => {
    const runtime = await GraphRuntime.mount(h(SiblingHost, { spawn: false }));
    runtimeHolder = runtime;

    const reconcileP = runtime.reconcile(h(SiblingHost, { spawn: true }));
    const raced = await Promise.race([
      reconcileP.then(
        () => 'done' as const,
        (err: unknown) => ({ rejected: String(err) }),
      ),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), 3000);
      }),
    ]);

    expect(raced).not.toBe('timeout');
    expect(FirstUnmountChild.reached).toBe(true);
    expect(SecondUnmountChild.reached).toBe(true);
    expect(String(SecondUnmountChild.nestedError)).toMatch(
      /cannot be awaited from inside an in-flight|teardown was scheduled/,
    );

    await expect(runtime.unmount()).resolves.toBeUndefined();
    expect(runtime.isActive()).toBe(false);
  });

  it('retry await unmount after catch inside same onMount rejects (no deadlock)', async () => {
    const runtime = await GraphRuntime.mount(h(RetryHost, { spawn: false }));
    runtimeHolder = runtime;

    const reconcileP = runtime.reconcile(h(RetryHost, { spawn: true }));
    const raced = await Promise.race([
      reconcileP.then(
        () => 'done' as const,
        (err: unknown) => ({ rejected: String(err) }),
      ),
      new Promise<'timeout'>((resolve) => {
        setTimeout(() => resolve('timeout'), 3000);
      }),
    ]);

    expect(raced).not.toBe('timeout');
    expect(RetryUnmountChild.reached).toBe(true);
    expect(String(RetryUnmountChild.secondError)).toMatch(
      /cannot be awaited from inside an in-flight|teardown was scheduled/,
    );

    await expect(runtime.unmount()).resolves.toBeUndefined();
    expect(runtime.isActive()).toBe(false);
  });
});
