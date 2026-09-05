/**
 * Entity tests for Component-based bootstrap path: startup/shutdown via lifecycle hooks,
 * partial failure cleanup, reverse shutdown order via parent→child, external runtime primitives.
 */

import {
  CommandBus,
  Component,
  EventBus,
  HandleRegistry,
  QueryBus,
  bootstrap,
  h,
} from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

interface TestRootProps {
  tag: string;
}

interface TestRootState {
  started: boolean;
}

class TestRoot extends Component<TestRootState, TestRootProps> {
  public mountCalled = 0;
  public unmountCalled = 0;

  constructor (props: TestRootProps) {
    super(props);
    this.state = { started: false };
  }

  public override onMount (): void {
    this.mountCalled += 1;
    this.setState({ started: true });
  }

  public override onUnmount (): void {
    this.unmountCalled += 1;
  }

  public override compose (): null {
    return null;
  }
}

let reconcileChildMountCount = 0;

/**
 * Test child component for verifying manual bootstrap-handle reconcile.
 */
class ReconcileChild extends Component<Record<string, never>, Record<string, never>> {
  /**
   * Creates a child test component.
   *
   * @param {Record<string, never>} props - empty props.
   */
  constructor (props: Record<string, never>) {
    super(props);
    this.state = {};
  }

  /**
   * Records that the component was mounted.
   *
   * @returns {void}
   */
  public override onMount (): void {
    reconcileChildMountCount += 1;
  }
}

/**
 * Root component whose `compose()` depends on state.
 */
class ReconcileRoot extends Component<{ showChild: boolean }, TestRootProps> {
  /**
   * Creates a root component for verifying `BootstrapHandle.reconcile()`.
   *
   * @param {TestRootProps} props - root component props.
   */
  constructor (props: TestRootProps) {
    super(props);
    this.state = { showChild: false };
  }

  /**
   * Returns a child node only after state changes.
   *
   * @returns {VirtualServiceNode[] | null} child nodes or `null`.
   */
  public override compose (): VirtualServiceNode[] | null {
    if (!this.state.showChild) {
      return null;
    }

    return [h(ReconcileChild, {}, 'reconcile-child')];
  }
}

describe('bootstrap — startup/shutdown lifecycle', () => {
  it('returns a running handle with an initialized root component', async () => {
    const handle = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'basic' }, {
      name: 'test-root',
    });

    expect(handle.isRunning()).toBe(true);
    expect(handle.name).toBe('test-root');
    expect(handle.rootInstance).toBeInstanceOf(TestRoot);
    expect(handle.rootInstance.mountCalled).toBe(1);
    expect(handle.rootInstance.state.started).toBe(true);
    expect(handle.props.tag).toBe('basic');

    await handle.shutdown();
  });

  it('isRunning() returns false after shutdown()', async () => {
    const handle = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'running' });

    expect(handle.isRunning()).toBe(true);
    await handle.shutdown();
    expect(handle.isRunning()).toBe(false);
  });

  it('shutdown() calls onUnmount on the root component', async () => {
    const handle = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'teardown' });
    const instance = handle.rootInstance;

    expect(instance.unmountCalled).toBe(0);

    await handle.shutdown();

    expect(instance.unmountCalled).toBe(1);
  });

  it('repeated shutdown() is idempotent and does not call lifecycle hooks twice', async () => {
    const handle = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'idempotent' });
    const instance = handle.rootInstance;

    await handle.shutdown();
    await handle.shutdown();

    expect(instance.unmountCalled).toBe(1);
  });

  it('handle contains runtime primitives: commandBus, queryBus, eventBus, handleRegistry', async () => {
    const handle = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'runtime' });

    expect(handle.runtime.commandBus).toBeInstanceOf(CommandBus);
    expect(handle.runtime.queryBus).toBeInstanceOf(QueryBus);
    expect(handle.runtime.eventBus).toBeInstanceOf(EventBus);
    expect(handle.runtime.handleRegistry).toBeInstanceOf(HandleRegistry);

    await handle.shutdown();
  });

  it('with the default name handle.name == effectable.root', async () => {
    const handle = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'default-name' });

    expect(handle.name).toBe('effectable.root');
    await handle.shutdown();
  });

  it('BOOT-04: options.name === "" falls back to effectable.root', async () => {
    const handle = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'empty-name' }, {
      name: '',
    });

    expect(handle.name).toBe('effectable.root');
    expect(handle.identity.rootId).toBe('effectable.root');
    await handle.shutdown();
  });

  it('handle.identity contains rootId/nodeId/displayName equal to name', async () => {
    const handle = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'identity' }, {
      name: 'identity-root',
    });

    expect(handle.identity.rootId).toBe('identity-root');
    expect(handle.identity.nodeId).toBe('identity-root');
    expect(handle.identity.displayName).toBe('identity-root');
    expect(handle.identity.kind).toBe('ROOT');
    expect(handle.identity.ownership).toBe('RUNTIME_OWNED');

    await handle.shutdown();
  });

  it('rebuilds the compose subtree via handle.reconcile()', async () => {
    reconcileChildMountCount = 0;
    const handle = await bootstrap<TestRootProps, ReconcileRoot>(ReconcileRoot, { tag: 'reconcile' });

    expect(reconcileChildMountCount).toBe(0);

    handle.rootInstance.setState({ showChild: true });
    expect(reconcileChildMountCount).toBe(0);

    await handle.reconcile();
    expect(reconcileChildMountCount).toBe(1);

    await handle.shutdown();
  });

  it('automatically reconciles the subtree after setState() without calling handle.reconcile()', async () => {
    reconcileChildMountCount = 0;
    const handle = await bootstrap<TestRootProps, ReconcileRoot>(ReconcileRoot, { tag: 'auto-reconcile' });

    expect(reconcileChildMountCount).toBe(0);

    handle.rootInstance.setState({ showChild: true });

    // Automatic reconcile is scheduled via queueMicrotask — not yet run
    expect(reconcileChildMountCount).toBe(0);

    // Flush the microtask queue: Promise.resolve() creates a microtask checkpoint
    await Promise.resolve();

    expect(reconcileChildMountCount).toBe(1);

    await handle.shutdown();
  });
});

describe('bootstrap — partial startup failure cleanup', () => {
  class FailingOnMountRoot extends Component<Record<string, never>, TestRootProps> {
    constructor (props: TestRootProps) {
      super(props);
    }

    public override onMount (): void {
      throw new Error(`onMount failed: ${this.props.tag}`);
    }

    public override compose (): null {
      return null;
    }
  }

  it('BOOT-15: sync onMount fail — reject and clear all owned primitives', async () => {
    const commandClearSpy = jest.spyOn(CommandBus.prototype, 'clear');
    const queryClearSpy = jest.spyOn(QueryBus.prototype, 'clear');
    const eventClearSpy = jest.spyOn(EventBus.prototype, 'clear');
    const registryClearSpy = jest.spyOn(HandleRegistry.prototype, 'clear');

    await expect(
      bootstrap<TestRootProps, FailingOnMountRoot>(FailingOnMountRoot, { tag: 'sync-fail' }),
    ).rejects.toThrow('onMount failed: sync-fail');

    expect(commandClearSpy).toHaveBeenCalledTimes(1);
    expect(queryClearSpy).toHaveBeenCalledTimes(1);
    expect(eventClearSpy).toHaveBeenCalledTimes(1);
    expect(registryClearSpy).toHaveBeenCalledTimes(1);

    commandClearSpy.mockRestore();
    queryClearSpy.mockRestore();
    eventClearSpy.mockRestore();
    registryClearSpy.mockRestore();
  });

  class FailingOnMountAsyncRoot extends Component<Record<string, never>, TestRootProps> {
    constructor (props: TestRootProps) {
      super(props);
    }

    public override async onMount (): Promise<void> {
      await Promise.resolve();
      throw new Error(`onMount failed: ${this.props.tag}`);
    }

    public override compose (): null {
      return null;
    }
  }

  it('BOOT-17: async onMount fail — reject and clear all owned primitives', async () => {
    const commandClearSpy = jest.spyOn(CommandBus.prototype, 'clear');
    const queryClearSpy = jest.spyOn(QueryBus.prototype, 'clear');
    const eventClearSpy = jest.spyOn(EventBus.prototype, 'clear');
    const registryClearSpy = jest.spyOn(HandleRegistry.prototype, 'clear');

    await expect(
      bootstrap<TestRootProps, FailingOnMountAsyncRoot>(FailingOnMountAsyncRoot, { tag: 'async-fail' }),
    ).rejects.toThrow('onMount failed: async-fail');

    expect(commandClearSpy).toHaveBeenCalledTimes(1);
    expect(queryClearSpy).toHaveBeenCalledTimes(1);
    expect(eventClearSpy).toHaveBeenCalledTimes(1);
    expect(registryClearSpy).toHaveBeenCalledTimes(1);

    commandClearSpy.mockRestore();
    queryClearSpy.mockRestore();
    eventClearSpy.mockRestore();
    registryClearSpy.mockRestore();
  });

  it('cleanup is not called on successful start until explicit shutdown()', async () => {
    const handle = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'no-early-cleanup' });

    expect(handle.rootInstance.unmountCalled).toBe(0);

    await handle.shutdown();

    expect(handle.rootInstance.unmountCalled).toBe(1);
  });
});

describe('bootstrap — async lifecycle', () => {
  class AsyncTestRoot extends Component<TestRootState, TestRootProps> {
    public mountResolved = false;

    constructor (props: TestRootProps) {
      super(props);
      this.state = { started: false };
    }

    public override async onMount (): Promise<void> {
      await Promise.resolve();
      this.mountResolved = true;
      this.setState({ started: true });
    }

    public override compose (): null {
      return null;
    }
  }

  it('supports async onMount', async () => {
    const handle = await bootstrap<TestRootProps, AsyncTestRoot>(AsyncTestRoot, { tag: 'async' });

    expect(handle.isRunning()).toBe(true);
    expect(handle.rootInstance.mountResolved).toBe(true);
    expect(handle.rootInstance.state.started).toBe(true);

    await handle.shutdown();
  });

  class AsyncTeardownRoot extends Component<Record<string, never>, TestRootProps> {
    public unmountResolved = false;

    constructor (props: TestRootProps) {
      super(props);
    }

    public override async onUnmount (): Promise<void> {
      await Promise.resolve();
      this.unmountResolved = true;
    }

    public override compose (): null {
      return null;
    }
  }

  it('supports async onUnmount', async () => {
    const handle = await bootstrap<TestRootProps, AsyncTeardownRoot>(AsyncTeardownRoot, { tag: 'async-teardown' });

    await handle.shutdown();

    expect(handle.rootInstance.unmountResolved).toBe(true);
  });
});

describe('bootstrap — reverse shutdown order via parent→child chain', () => {
  const callOrder: string[] = [];

  beforeEach(() => {
    callOrder.length = 0;
  });

  class ChildComponent extends Component<Record<string, never>, { id: string }> {
    constructor (props: { id: string }) {
      super(props);
    }

    public override onMount (): void {
      callOrder.push(`${this.props.id}:mount`);
    }

    public override onUnmount (): void {
      callOrder.push(`${this.props.id}:unmount`);
    }

    public override compose (): null {
      return null;
    }
  }

  class ParentComponent extends Component<Record<string, never>, { id: string }> {
    constructor (props: { id: string }) {
      super(props);
    }

    public override onMount (): void {
      callOrder.push(`${this.props.id}:mount`);
    }

    public override onUnmount (): void {
      callOrder.push(`${this.props.id}:unmount`);
    }

    public override compose (): VirtualServiceNode[] {
      return [
        h(ChildComponent, { id: 'child1' }),
        h(ChildComponent, { id: 'child2' }),
      ];
    }
  }

  it('startup: children before parent; shutdown: same order (children → parent)', async () => {
    const handle = await bootstrap<{ id: string }, ParentComponent>(
      ParentComponent,
      { id: 'parent' },
      { name: 'chain' }
    );

    expect(callOrder).toEqual([
      'child1:mount',
      'child2:mount',
      'parent:mount',
    ]);

    await handle.shutdown();

    expect(callOrder).toEqual([
      'child1:mount',
      'child2:mount',
      'parent:mount',
      'child1:unmount',
      'child2:unmount',
      'parent:unmount',
    ]);
  });

  it('isRunning() changes before the unmount lifecycle hook is called', async () => {
    const stateBeforeTeardown: boolean[] = [];

    class ObservingRoot extends Component<Record<string, never>, TestRootProps> {
      public owner: { isRunning: () => boolean } | null = null;

      constructor (props: TestRootProps) {
        super(props);
      }

      public override onUnmount (): void {
        if (this.owner !== null) {
          stateBeforeTeardown.push(this.owner.isRunning());
        }
      }

      public override compose (): null {
        return null;
      }
    }

    const handle = await bootstrap<TestRootProps, ObservingRoot>(ObservingRoot, { tag: 'state-order' });
    handle.rootInstance.owner = handle;

    await handle.shutdown();

    expect(stateBeforeTeardown[0]).toBe(false);
  });
});

describe('bootstrap — external runtime primitives', () => {
  it('uses the provided commandBus, queryBus, eventBus and handleRegistry without replacement', async () => {
    const commandBus = new CommandBus();
    const queryBus = new QueryBus();
    const eventBus = new EventBus();
    const handleRegistry = new HandleRegistry();

    const handle = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'ext' }, {
      runtime: { commandBus, queryBus, eventBus, handleRegistry },
    });

    expect(handle.runtime.commandBus).toBe(commandBus);
    expect(handle.runtime.queryBus).toBe(queryBus);
    expect(handle.runtime.eventBus).toBe(eventBus);
    expect(handle.runtime.handleRegistry).toBe(handleRegistry);

    await handle.shutdown();
  });

  it('BOOT-25: does not clear external commandBus/queryBus/eventBus/handleRegistry on shutdown', async () => {
    const commandBus = new CommandBus();
    const queryBus = new QueryBus();
    const eventBus = new EventBus();
    const handleRegistry = new HandleRegistry();
    const commandClearSpy = jest.spyOn(commandBus, 'clear');
    const queryClearSpy = jest.spyOn(queryBus, 'clear');
    const eventClearSpy = jest.spyOn(eventBus, 'clear');
    const registryClearSpy = jest.spyOn(handleRegistry, 'clear');

    const handle = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'ext-no-clear' }, {
      runtime: { commandBus, queryBus, eventBus, handleRegistry },
    });

    await handle.shutdown();

    expect(commandClearSpy).not.toHaveBeenCalled();
    expect(queryClearSpy).not.toHaveBeenCalled();
    expect(eventClearSpy).not.toHaveBeenCalled();
    expect(registryClearSpy).not.toHaveBeenCalled();
  });
});

describe('bootstrap — onAutoReconcileError hook', () => {
  class ErrorComposeRoot extends Component<{ shouldThrow: boolean }, TestRootProps> {
    constructor (props: TestRootProps) {
      super(props);
      this.state = { shouldThrow: false };
    }

    public override compose (): null {
      if (this.state.shouldThrow) {
        throw new Error('compose error during auto-reconcile');
      }

      return null;
    }
  }

  it('calls onAutoReconcileError when compose() throws during auto-reconcile', async () => {
    const capturedErrors: unknown[] = [];

    const handle = await bootstrap<TestRootProps, ErrorComposeRoot>(
      ErrorComposeRoot,
      { tag: 'error-hook' },
      {
        onAutoReconcileError: (err) => {
          capturedErrors.push(err);
        },
      },
    );

    handle.rootInstance.setState({ shouldThrow: true });

    await Promise.resolve();
    await Promise.resolve();

    expect(capturedErrors).toHaveLength(1);
    expect(capturedErrors[0]).toBeInstanceOf(Error);
    expect((capturedErrors[0] as Error).message).toBe('compose error during auto-reconcile');

    await handle.shutdown();
  });

  it('does not call onAutoReconcileError on successful auto-reconcile', async () => {
    const capturedErrors: unknown[] = [];

    const handle = await bootstrap<TestRootProps, ErrorComposeRoot>(
      ErrorComposeRoot,
      { tag: 'no-error-hook' },
      {
        onAutoReconcileError: (err) => {
          capturedErrors.push(err);
        },
      },
    );

    handle.rootInstance.setState({ shouldThrow: false });

    await Promise.resolve();
    await Promise.resolve();

    expect(capturedErrors).toHaveLength(0);

    await handle.shutdown();
  });

  it('does not crash if onAutoReconcileError is omitted and compose() throws', async () => {
    const handle = await bootstrap<TestRootProps, ErrorComposeRoot>(
      ErrorComposeRoot,
      { tag: 'no-hook-no-crash' },
    );

    handle.rootInstance.setState({ shouldThrow: true });

    await Promise.resolve();
    await Promise.resolve();

    await handle.shutdown();
  });
});

describe('bootstrap — partially provided runtime', () => {
  it('creates missing buses when only eventBus is provided', async () => {
    const eventBus = new EventBus();

    const handle = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'partial-rt' }, {
      runtime: { eventBus },
    });

    expect(handle.runtime.eventBus).toBe(eventBus);
    expect(handle.runtime.commandBus).toBeInstanceOf(CommandBus);
    expect(handle.runtime.queryBus).toBeInstanceOf(QueryBus);
    expect(handle.runtime.handleRegistry).toBeInstanceOf(HandleRegistry);
    expect(handle.isRunning()).toBe(true);

    await handle.shutdown();
  });

  it('clears only owned primitives on shutdown (partially provided runtime)', async () => {
    const eventBus = new EventBus();
    const externalClearSpy = jest.spyOn(eventBus, 'clear');

    const handle = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'partial-owned' }, {
      runtime: { eventBus },
    });

    const internalCommandBus = handle.runtime.commandBus;
    const internalClearSpy = jest.spyOn(internalCommandBus, 'clear');

    await handle.shutdown();

    expect(externalClearSpy).not.toHaveBeenCalled();
    expect(internalClearSpy).toHaveBeenCalledTimes(1);
  });
});

describe('bootstrap — parallel bootstrap (overlap)', () => {
  it('BOOT-44: two parallel bootstraps live simultaneously without mutual shutdown', async () => {
    const [first, second] = await Promise.all([
      bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'parallel-a' }, {
        name: 'parallel-bootstrap-a',
      }),
      bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'parallel-b' }, {
        name: 'parallel-bootstrap-b',
      }),
    ]);

    expect(first.isRunning()).toBe(true);
    expect(second.isRunning()).toBe(true);
    expect(first.props.tag).toBe('parallel-a');
    expect(second.props.tag).toBe('parallel-b');
    expect(first.runtime.commandBus).not.toBe(second.runtime.commandBus);

    await first.shutdown();
    expect(first.isRunning()).toBe(false);
    expect(second.isRunning()).toBe(true);
    expect(second.rootInstance.mountCalled).toBe(1);

    await second.shutdown();
    expect(second.isRunning()).toBe(false);
  });
});

describe('bootstrap — A13 sequential bootstraps', () => {
  it('A13: two sequential bootstraps with different names — both handles alive and independent', async () => {
    const first = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'seq-a' }, {
      name: 'bootstrap-seq-a',
    });
    const second = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'seq-b' }, {
      name: 'bootstrap-seq-b',
    });

    expect(first.isRunning()).toBe(true);
    expect(second.isRunning()).toBe(true);
    expect(first.name).toBe('bootstrap-seq-a');
    expect(second.name).toBe('bootstrap-seq-b');
    expect(first.rootInstance).not.toBe(second.rootInstance);
    expect(first.runtime.commandBus).not.toBe(second.runtime.commandBus);

    await first.shutdown();
    expect(first.isRunning()).toBe(false);
    expect(second.isRunning()).toBe(true);

    await second.shutdown();
    expect(second.isRunning()).toBe(false);
  });

  it('A13: two bootstraps under the same name — both succeed (no global name lock)', async () => {
    const sharedName = 'duplicate-bootstrap-name';

    const first = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'dup-1' }, {
      name: sharedName,
    });
    const second = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'dup-2' }, {
      name: sharedName,
    });

    expect(first.isRunning()).toBe(true);
    expect(second.isRunning()).toBe(true);
    expect(first.name).toBe(sharedName);
    expect(second.name).toBe(sharedName);
    expect(first.props.tag).toBe('dup-1');
    expect(second.props.tag).toBe('dup-2');

    await first.shutdown();
    await second.shutdown();
  });
});

describe('bootstrap — P0/P1 reconcile and owned clear', () => {
  /**
   * Root for manual reconcile: throw flag via a field (no setState),
   * so auto-reconcile microtask is not scheduled.
   */
  class ManualReconcileComposeRoot extends Component<Record<string, never>, TestRootProps> {
    public composeCalls = 0;
    public forceComposeThrow = false;

    constructor (props: TestRootProps) {
      super(props);
      this.state = {};
    }

    public override compose (): null {
      this.composeCalls += 1;
      if (this.forceComposeThrow) {
        throw new Error('compose error during manual reconcile');
      }

      return null;
    }
  }

  it('BOOT-35: reconcile() after shutdown — no-op (isRunning false, compose does not grow)', async () => {
    const handle = await bootstrap<TestRootProps, ManualReconcileComposeRoot>(
      ManualReconcileComposeRoot,
      { tag: 'reconcile-after-shutdown' },
    );
    const instance = handle.rootInstance;
    const composeAfterMount = instance.composeCalls;

    await handle.shutdown();
    expect(handle.isRunning()).toBe(false);

    await expect(handle.reconcile()).resolves.toBeUndefined();
    expect(instance.composeCalls).toBe(composeAfterMount);
  });

  it('BOOT-36: manual handle.reconcile() rethrows compose error', async () => {
    const handle = await bootstrap<TestRootProps, ManualReconcileComposeRoot>(
      ManualReconcileComposeRoot,
      { tag: 'manual-reconcile-throw' },
    );

    handle.rootInstance.forceComposeThrow = true;

    await expect(handle.reconcile()).rejects.toThrow('compose error during manual reconcile');
    // Fail-stop tears down GraphRuntime; handle must not claim it is still live.
    expect(handle.isRunning()).toBe(false);

    await handle.shutdown();
  });

  it('BOOT-37: successful shutdown clears all four owned primitives', async () => {
    const handle = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'owned-clear-ok' });

    const commandClearSpy = jest.spyOn(handle.runtime.commandBus, 'clear');
    const queryClearSpy = jest.spyOn(handle.runtime.queryBus, 'clear');
    const eventClearSpy = jest.spyOn(handle.runtime.eventBus, 'clear');
    const registryClearSpy = jest.spyOn(handle.runtime.handleRegistry, 'clear');

    await handle.shutdown();

    expect(commandClearSpy).toHaveBeenCalledTimes(1);
    expect(queryClearSpy).toHaveBeenCalledTimes(1);
    expect(eventClearSpy).toHaveBeenCalledTimes(1);
    expect(registryClearSpy).toHaveBeenCalledTimes(1);
  });

  it('BOOT-45: repeated shutdown does not clear owned primitives again', async () => {
    const handle = await bootstrap<TestRootProps, TestRoot>(TestRoot, { tag: 'clear-idempotent' });

    const commandClearSpy = jest.spyOn(handle.runtime.commandBus, 'clear');
    const queryClearSpy = jest.spyOn(handle.runtime.queryBus, 'clear');
    const eventClearSpy = jest.spyOn(handle.runtime.eventBus, 'clear');
    const registryClearSpy = jest.spyOn(handle.runtime.handleRegistry, 'clear');

    await handle.shutdown();
    await handle.shutdown();

    expect(commandClearSpy).toHaveBeenCalledTimes(1);
    expect(queryClearSpy).toHaveBeenCalledTimes(1);
    expect(eventClearSpy).toHaveBeenCalledTimes(1);
    expect(registryClearSpy).toHaveBeenCalledTimes(1);
  });
});
