/**
 * Bootstrap: teardown observability (issue #20).
 *
 * Tests that bootstrap().shutdown() exposes cleanup errors and always clears owned buses.
 *
 * @module Effectable/bootstrap/bootstrap.teardown-observability.test
 */

import {
  CommandBus,
  Component,
  EventBus,
  HandleRegistry,
  QueryBus,
  bootstrap,
} from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

describe('bootstrap teardown observability (issue #20)', () => {
  describe('owned buses/registries cleared after unmount rejection', () => {
    interface FailUnmountProps {
      tag: string;
    }

    class FailUnmountRoot extends Component<Record<string, never>, FailUnmountProps> {
      constructor (props: FailUnmountProps) {
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

    it('default shutdown() clears owned primitives in finally even when onUnmount throws', async () => {
      const handle = await bootstrap<FailUnmountProps, FailUnmountRoot>(
        FailUnmountRoot,
        { tag: 'default-shutdown' },
        { name: 'boot-20-default' },
      );

      const commandClearSpy = jest.spyOn(handle.runtime.commandBus, 'clear');
      const queryClearSpy = jest.spyOn(handle.runtime.queryBus, 'clear');
      const eventClearSpy = jest.spyOn(handle.runtime.eventBus, 'clear');
      const registryClearSpy = jest.spyOn(handle.runtime.handleRegistry, 'clear');

      // Default shutdown swallows errors and clears primitives
      await expect(handle.shutdown()).resolves.toBeUndefined();

      expect(commandClearSpy).toHaveBeenCalledTimes(1);
      expect(queryClearSpy).toHaveBeenCalledTimes(1);
      expect(eventClearSpy).toHaveBeenCalledTimes(1);
      expect(registryClearSpy).toHaveBeenCalledTimes(1);
      expect(handle.isRunning()).toBe(false);

      commandClearSpy.mockRestore();
      queryClearSpy.mockRestore();
      eventClearSpy.mockRestore();
      registryClearSpy.mockRestore();
    });

    it('shutdown({ rejectOnCleanupError: true }) exposes error but still clears primitives', async () => {
      const handle = await bootstrap<FailUnmountProps, FailUnmountRoot>(
        FailUnmountRoot,
        { tag: 'opt-in-shutdown' },
        { name: 'boot-20-opt-in' },
      );

      const commandClearSpy = jest.spyOn(handle.runtime.commandBus, 'clear');
      const queryClearSpy = jest.spyOn(handle.runtime.queryBus, 'clear');
      const eventClearSpy = jest.spyOn(handle.runtime.eventBus, 'clear');
      const registryClearSpy = jest.spyOn(handle.runtime.handleRegistry, 'clear');

      // Opt-in shutdown rejects with the error
      await expect(handle.shutdown({ rejectOnCleanupError: true })).rejects.toThrow(
        'unmount failed: opt-in-shutdown',
      );

      // But primitives are still cleared via finally
      expect(commandClearSpy).toHaveBeenCalledTimes(1);
      expect(queryClearSpy).toHaveBeenCalledTimes(1);
      expect(eventClearSpy).toHaveBeenCalledTimes(1);
      expect(registryClearSpy).toHaveBeenCalledTimes(1);
      expect(handle.isRunning()).toBe(false);

      commandClearSpy.mockRestore();
      queryClearSpy.mockRestore();
      eventClearSpy.mockRestore();
      registryClearSpy.mockRestore();
    });

    it('external runtime primitives are not cleared on shutdown failure', async () => {
      const externalCommandBus = new CommandBus();
      const externalQueryBus = new QueryBus();
      const externalClearSpyCommand = jest.spyOn(externalCommandBus, 'clear');
      const externalClearSpyQuery = jest.spyOn(externalQueryBus, 'clear');
      const eventClearSpy = jest.spyOn(EventBus.prototype, 'clear');
      const registryClearSpy = jest.spyOn(HandleRegistry.prototype, 'clear');

      const handle = await bootstrap<FailUnmountProps, FailUnmountRoot>(
        FailUnmountRoot,
        { tag: 'external-runtime' },
        {
          name: 'boot-20-external',
          runtime: { commandBus: externalCommandBus, queryBus: externalQueryBus },
        },
      );

      // Default shutdown swallows errors
      await expect(handle.shutdown()).resolves.toBeUndefined();

      // External primitives should NOT be cleared
      expect(externalClearSpyCommand).not.toHaveBeenCalled();
      expect(externalClearSpyQuery).not.toHaveBeenCalled();

      // Owned primitives (eventBus, handleRegistry) should be cleared
      expect(eventClearSpy).toHaveBeenCalledTimes(1);
      expect(registryClearSpy).toHaveBeenCalledTimes(1);
      expect(handle.isRunning()).toBe(false);

      externalClearSpyCommand.mockRestore();
      externalClearSpyQuery.mockRestore();
      eventClearSpy.mockRestore();
      registryClearSpy.mockRestore();
    });
  });

  describe('concurrent shutdown joins one promise', () => {
    class SlowUnmountRoot extends Component<Record<string, never>, Record<string, never>> {
      public unmountStarted = false;

      public unmountCompleted = false;

      constructor (props: Record<string, never>) {
        super(props);
        this.state = {};
      }

      public override async onUnmount (): Promise<void> {
        this.unmountStarted = true;
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
        this.unmountCompleted = true;
      }

      public override compose (): null {
        return null;
      }
    }

    it('concurrent shutdown() calls await the same promise and join in-flight shutdown', async () => {
      const handle = await bootstrap<Record<string, never>, SlowUnmountRoot>(
        SlowUnmountRoot,
        {},
        { name: 'boot-20-concurrent' },
      );

      expect(handle.isRunning()).toBe(true);

      // Start first shutdown
      const shutdown1 = handle.shutdown();

      // Wait a bit to ensure first shutdown has started and flipped running = false
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      // At this point: running = false, but unmountCompleted should still be false
      expect(handle.isRunning()).toBe(false);
      expect(handle.rootInstance.unmountCompleted).toBe(false);

      // Start second shutdown - it must join the in-flight shutdown, not return early
      const shutdown2 = handle.shutdown();

      // Wait for both to complete
      await Promise.all([shutdown1, shutdown2]);

      // Now unmount should be completed
      expect(handle.isRunning()).toBe(false);
      expect(handle.rootInstance.unmountStarted).toBe(true);
      expect(handle.rootInstance.unmountCompleted).toBe(true);
    });

    it('third shutdown() call after completion returns immediately', async () => {
      const handle = await bootstrap<Record<string, never>, SlowUnmountRoot>(
        SlowUnmountRoot,
        {},
        { name: 'boot-20-third-call' },
      );

      expect(handle.isRunning()).toBe(true);

      // First shutdown
      await handle.shutdown();

      expect(handle.isRunning()).toBe(false);
      expect(handle.rootInstance.unmountCompleted).toBe(true);

      // Second shutdown after completion should return immediately (no-op)
      const shutdown2Start = Date.now();
      await handle.shutdown();
      const shutdown2Duration = Date.now() - shutdown2Start;

      // Should be essentially instant (< 5ms)
      expect(shutdown2Duration).toBeLessThan(5);
    });
  });

  describe('cleanup errors are observable', () => {
    interface MultiChildProps {
      children: Array<{ key: string; label: string; fail: boolean }>;
    }

    class FailChildLeaf extends Component<
      Record<string, never>,
      { label: string; fail: boolean }
    > {
      constructor (props: { label: string; fail: boolean }) {
        super(props);
        this.state = {};
      }

      public override onUnmount (): void {
        if (this.props.fail) {
          throw new Error(`leaf unmount failed: ${this.props.label}`);
        }
      }

      public override compose (): null {
        return null;
      }
    }

    class MultiChildRoot extends Component<Record<string, never>, MultiChildProps> {
      constructor (props: MultiChildProps) {
        super(props);
        this.state = {};
      }

      public override compose (): VirtualServiceNode[] {
        return this.props.children.map((child) => ({
          type: FailChildLeaf,
          props: { label: child.label, fail: child.fail },
          children: [],
          key: child.key,
        }));
      }
    }

    it('shutdown with default behavior swallows multiple child errors', async () => {
      const handle = await bootstrap<MultiChildProps, MultiChildRoot>(
        MultiChildRoot,
        {
          children: [
            { key: 'a', label: 'first', fail: true },
            { key: 'b', label: 'second', fail: false },
            { key: 'c', label: 'third', fail: true },
          ],
        },
        { name: 'boot-20-multi-errors' },
      );

      expect(handle.isRunning()).toBe(true);

      // Default shutdown swallows all errors
      await expect(handle.shutdown()).resolves.toBeUndefined();
      expect(handle.isRunning()).toBe(false);
    });

    it('shutdown({ rejectOnCleanupError: true }) exposes multiple child errors', async () => {
      const handle = await bootstrap<MultiChildProps, MultiChildRoot>(
        MultiChildRoot,
        {
          children: [
            { key: 'a', label: 'first', fail: true },
            { key: 'b', label: 'second', fail: false },
            { key: 'c', label: 'third', fail: true },
          ],
        },
        { name: 'boot-20-multi-errors-opt-in' },
      );

      expect(handle.isRunning()).toBe(true);

      try {
        await handle.shutdown({ rejectOnCleanupError: true });
        throw new Error('Expected shutdown to reject');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(AggregateError);
        const aggError = error as AggregateError;
        expect(aggError.errors.length).toBeGreaterThanOrEqual(2);
        expect(aggError.errors[0]).toBeInstanceOf(Error);
        expect((aggError.errors[0] as Error).message).toContain('leaf unmount failed');
      }

      expect(handle.isRunning()).toBe(false);
    });
  });
});
