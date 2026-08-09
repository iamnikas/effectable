/**
 * A14: bootstrap of a deep compose tree (depth ≥ 32) with leaf failure at startup.
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

jest.setTimeout(120_000);

const DEEP_DEPTH = 32;

interface DeepProps {
  depth: number;
  failAt: number;
}

class DeepFailNode extends Component<Record<string, never>, DeepProps> {
  constructor (props: DeepProps) {
    super(props);
  }

  public override onMount (): void {
    if (this.props.depth === this.props.failAt) {
      throw new Error(`deep leaf fail at depth ${String(this.props.depth)}`);
    }
  }

  public override compose (): VirtualServiceNode[] | null {
    if (this.props.depth <= 0) {
      return null;
    }

    return [
      h(DeepFailNode, {
        depth: this.props.depth - 1,
        failAt: this.props.failAt,
      }),
    ];
  }
}

class DeepHealthyNode extends Component<Record<string, never>, { depth: number }> {
  constructor (props: { depth: number }) {
    super(props);
  }

  public override compose (): VirtualServiceNode[] | null {
    if (this.props.depth <= 0) {
      return null;
    }

    return [h(DeepHealthyNode, { depth: this.props.depth - 1 })];
  }
}

interface ThrowUnmountProps {
  tag: string;
}

/**
 * Root whose onUnmount throws — for verifying finally-clear of owned primitives.
 */
class ThrowOnUnmountRoot extends Component<Record<string, never>, ThrowUnmountProps> {
  constructor (props: ThrowUnmountProps) {
    super(props);
    this.state = {};
  }

  public override onUnmount (): void {
    throw new Error(`unmount failed: ${this.props.tag}`);
  }

  public override compose (): null {
    return null;
  }
}

/**
 * Sync onMount fail for verifying external runtime is not cleared.
 */
class SyncFailRoot extends Component<Record<string, never>, ThrowUnmountProps> {
  constructor (props: ThrowUnmountProps) {
    super(props);
  }

  public override onMount (): void {
    throw new Error(`onMount failed: ${this.props.tag}`);
  }

  public override compose (): null {
    return null;
  }
}

describe('bootstrap — resilience A14', () => {
  it('at depth≥32 with leaf failure throws, clears owned primitives; isRunning false after shutdown', async () => {
    const commandClearSpy = jest.spyOn(CommandBus.prototype, 'clear');
    const queryClearSpy = jest.spyOn(QueryBus.prototype, 'clear');
    const eventClearSpy = jest.spyOn(EventBus.prototype, 'clear');
    const registryClearSpy = jest.spyOn(HandleRegistry.prototype, 'clear');

    await expect(
      bootstrap<DeepProps, DeepFailNode>(
        DeepFailNode,
        { depth: DEEP_DEPTH, failAt: 0 },
        { name: 'resilience-deep-fail' },
      ),
    ).rejects.toThrow('deep leaf fail at depth 0');

    expect(commandClearSpy).toHaveBeenCalledTimes(1);
    expect(queryClearSpy).toHaveBeenCalledTimes(1);
    expect(eventClearSpy).toHaveBeenCalledTimes(1);
    expect(registryClearSpy).toHaveBeenCalledTimes(1);

    commandClearSpy.mockRestore();
    queryClearSpy.mockRestore();
    eventClearSpy.mockRestore();
    registryClearSpy.mockRestore();

    const handle = await bootstrap<{ depth: number }, DeepHealthyNode>(
      DeepHealthyNode,
      { depth: DEEP_DEPTH },
      { name: 'resilience-deep-ok' },
    );

    expect(handle.isRunning()).toBe(true);
    await handle.shutdown();
    expect(handle.isRunning()).toBe(false);
  });
});

describe('bootstrap — resilience BOOT-38 / BOOT-39', () => {
  it('BOOT-38: shutdown clears owned in finally even if onUnmount throws (unmount error swallowed)', async () => {
    const handle = await bootstrap<ThrowUnmountProps, ThrowOnUnmountRoot>(
      ThrowOnUnmountRoot,
      { tag: 'unmount-throw' },
      { name: 'boot-38-unmount-throw' },
    );

    const commandClearSpy = jest.spyOn(handle.runtime.commandBus, 'clear');
    const queryClearSpy = jest.spyOn(handle.runtime.queryBus, 'clear');
    const eventClearSpy = jest.spyOn(handle.runtime.eventBus, 'clear');
    const registryClearSpy = jest.spyOn(handle.runtime.handleRegistry, 'clear');

    // LifecycleEngine swallows onUnmount error — shutdown resolves, finally clear still runs.
    await expect(handle.shutdown()).resolves.toBeUndefined();

    expect(commandClearSpy).toHaveBeenCalledTimes(1);
    expect(queryClearSpy).toHaveBeenCalledTimes(1);
    expect(eventClearSpy).toHaveBeenCalledTimes(1);
    expect(registryClearSpy).toHaveBeenCalledTimes(1);
    expect(handle.isRunning()).toBe(false);
  });

  it('BOOT-39: startup fail with external runtime — external clear not called, owned clear is called', async () => {
    const externalCommandBus = new CommandBus();
    const externalClearSpy = jest.spyOn(externalCommandBus, 'clear');
    const queryClearSpy = jest.spyOn(QueryBus.prototype, 'clear');
    const eventClearSpy = jest.spyOn(EventBus.prototype, 'clear');
    const registryClearSpy = jest.spyOn(HandleRegistry.prototype, 'clear');

    await expect(
      bootstrap<ThrowUnmountProps, SyncFailRoot>(
        SyncFailRoot,
        { tag: 'ext-fail' },
        {
          name: 'boot-39-ext-fail',
          runtime: { commandBus: externalCommandBus },
        },
      ),
    ).rejects.toThrow('onMount failed: ext-fail');

    expect(externalClearSpy).not.toHaveBeenCalled();
    expect(queryClearSpy).toHaveBeenCalledTimes(1);
    expect(eventClearSpy).toHaveBeenCalledTimes(1);
    expect(registryClearSpy).toHaveBeenCalledTimes(1);

    externalClearSpy.mockRestore();
    queryClearSpy.mockRestore();
    eventClearSpy.mockRestore();
    registryClearSpy.mockRestore();
  });
});
