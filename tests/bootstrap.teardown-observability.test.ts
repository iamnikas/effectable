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
  h,
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
    interface LatchedUnmountProps {
      release?: () => void;
    }

    class LatchedUnmountRoot extends Component<
      Record<string, never>,
      LatchedUnmountProps
    > {
      public unmountStarted = false;

      public unmountCompleted = false;

      public unmountCalls = 0;

      private release: (() => void) | null = null;

      constructor (props: LatchedUnmountProps) {
        super(props);
        this.state = {};
      }

      public override async onUnmount (): Promise<void> {
        this.unmountCalls += 1;
        this.unmountStarted = true;

        await new Promise<void>((resolve) => {
          this.release = () => {
            resolve();
          };
          if (this.props.release) {
            this.props.release();
          }
        });

        this.unmountCompleted = true;
      }

      public releaseUnmount (): void {
        if (this.release) {
          this.release();
        }
      }

      public override compose (): null {
        return null;
      }
    }

    it('concurrent shutdown() calls await the same promise and join in-flight shutdown', async () => {
      let releaseCalled = false;
      const handle = await bootstrap<LatchedUnmountProps, LatchedUnmountRoot>(
        LatchedUnmountRoot,
        {
          release: () => {
            releaseCalled = true;
          },
        },
        { name: 'boot-20-concurrent' },
      );

      expect(handle.isRunning()).toBe(true);

      // Start first shutdown
      const shutdown1 = handle.shutdown();

      // Wait until shutdown has started (onUnmount called release callback)
      while (!releaseCalled) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }

      // At this point: onUnmount is in-flight, but not completed
      expect(handle.isRunning()).toBe(false);
      expect(handle.rootInstance.unmountStarted).toBe(true);
      expect(handle.rootInstance.unmountCompleted).toBe(false);

      // Start second shutdown - it must join the in-flight shutdown
      const shutdown2 = handle.shutdown();

      // Release the latch
      handle.rootInstance.releaseUnmount();

      // Wait for both to complete
      await Promise.all([shutdown1, shutdown2]);

      // Now shutdown should be completed, and onUnmount called only once
      expect(handle.isRunning()).toBe(false);
      expect(handle.rootInstance.unmountStarted).toBe(true);
      expect(handle.rootInstance.unmountCompleted).toBe(true);
      expect(handle.rootInstance.unmountCalls).toBe(1);
    });

    it('third shutdown() call after completion does not call onUnmount again', async () => {
      let releaseCalled = false;
      const handle = await bootstrap<LatchedUnmountProps, LatchedUnmountRoot>(
        LatchedUnmountRoot,
        {
          release: () => {
            releaseCalled = true;
          },
        },
        { name: 'boot-20-third-call' },
      );

      expect(handle.isRunning()).toBe(true);

      // Start first shutdown
      const shutdown1 = handle.shutdown();

      // Wait until shutdown has started
      while (!releaseCalled) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }

      // Release the latch to let shutdown complete
      handle.rootInstance.releaseUnmount();
      await shutdown1;

      expect(handle.isRunning()).toBe(false);
      expect(handle.rootInstance.unmountCompleted).toBe(true);
      expect(handle.rootInstance.unmountCalls).toBe(1);

      // Second shutdown after completion should be a no-op
      await handle.shutdown();

      // onUnmount should not have been called again
      expect(handle.rootInstance.unmountCalls).toBe(1);

      // Third shutdown also a no-op
      await handle.shutdown();
      expect(handle.rootInstance.unmountCalls).toBe(1);
    });

    it('third shutdown() call after completion does not clear owned buses again', async () => {
      let releaseCalled = false;
      const handle = await bootstrap<LatchedUnmountProps, LatchedUnmountRoot>(
        LatchedUnmountRoot,
        {
          release: () => {
            releaseCalled = true;
          },
        },
        { name: 'boot-20-third-clear' },
      );

      const commandClearSpy = jest.spyOn(handle.runtime.commandBus, 'clear');
      const queryClearSpy = jest.spyOn(handle.runtime.queryBus, 'clear');
      const eventClearSpy = jest.spyOn(handle.runtime.eventBus, 'clear');
      const registryClearSpy = jest.spyOn(handle.runtime.handleRegistry, 'clear');

      expect(handle.isRunning()).toBe(true);

      // Start first shutdown
      const shutdown1 = handle.shutdown();

      // Wait until shutdown has started
      while (!releaseCalled) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }

      // Release the latch to let shutdown complete
      handle.rootInstance.releaseUnmount();
      await shutdown1;

      expect(handle.isRunning()).toBe(false);
      expect(commandClearSpy).toHaveBeenCalledTimes(1);
      expect(queryClearSpy).toHaveBeenCalledTimes(1);
      expect(eventClearSpy).toHaveBeenCalledTimes(1);
      expect(registryClearSpy).toHaveBeenCalledTimes(1);

      // Second shutdown should not call clear() again
      await handle.shutdown();
      expect(commandClearSpy).toHaveBeenCalledTimes(1);
      expect(queryClearSpy).toHaveBeenCalledTimes(1);
      expect(eventClearSpy).toHaveBeenCalledTimes(1);
      expect(registryClearSpy).toHaveBeenCalledTimes(1);

      commandClearSpy.mockRestore();
      queryClearSpy.mockRestore();
      eventClearSpy.mockRestore();
      registryClearSpy.mockRestore();
    });

    it('concurrent join follows the first caller\'s options (mixed rejectOnCleanupError)', async () => {
      interface FailingUnmountProps {
        release?: () => void;
      }

      class FailingLatchedRoot extends Component<
        Record<string, never>,
        FailingUnmountProps
      > {
        public unmountStarted = false;

        public unmountCompleted = false;

        public unmountCalls = 0;

        private release: (() => void) | null = null;

        constructor (props: FailingUnmountProps) {
          super(props);
          this.state = {};
        }

        public override async onUnmount (): Promise<void> {
          this.unmountCalls += 1;
          this.unmountStarted = true;

          await new Promise<void>((resolve) => {
            this.release = () => {
              resolve();
            };
            if (this.props.release) {
              this.props.release();
            }
          });

          this.unmountCompleted = true;
          throw new Error('onUnmount cleanup error');
        }

        public releaseUnmount (): void {
          if (this.release) {
            this.release();
          }
        }

        public override compose (): null {
          return null;
        }
      }

      let releaseCalled = false;
      const handle = await bootstrap<FailingUnmountProps, FailingLatchedRoot>(
        FailingLatchedRoot,
        {
          release: () => {
            releaseCalled = true;
          },
        },
        { name: 'boot-20-mixed-options' },
      );

      const commandClearSpy = jest.spyOn(handle.runtime.commandBus, 'clear');
      const queryClearSpy = jest.spyOn(handle.runtime.queryBus, 'clear');
      const eventClearSpy = jest.spyOn(handle.runtime.eventBus, 'clear');
      const registryClearSpy = jest.spyOn(handle.runtime.handleRegistry, 'clear');

      expect(handle.isRunning()).toBe(true);

      // First caller: default (swallow errors)
      const shutdown1 = handle.shutdown();

      // Wait until shutdown has started
      while (!releaseCalled) {
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }

      expect(handle.rootInstance.unmountStarted).toBe(true);
      expect(handle.rootInstance.unmountCompleted).toBe(false);

      // Second caller: opt-in to rejection
      // But it should still RESOLVE because it joins the first caller's promise
      const shutdown2 = handle.shutdown({ rejectOnCleanupError: true });

      // Release the latch
      handle.rootInstance.releaseUnmount();

      // First caller resolves (swallows error)
      await expect(shutdown1).resolves.toBeUndefined();

      // Second caller also resolves (follows first caller's options)
      // This documents current contract: concurrent join uses the first caller's options
      await expect(shutdown2).resolves.toBeUndefined();

      // Cleanup still ran
      expect(handle.rootInstance.unmountCalls).toBe(1);
      expect(handle.isRunning()).toBe(false);

      // Owned buses were still cleared
      expect(commandClearSpy).toHaveBeenCalledTimes(1);
      expect(queryClearSpy).toHaveBeenCalledTimes(1);
      expect(eventClearSpy).toHaveBeenCalledTimes(1);
      expect(registryClearSpy).toHaveBeenCalledTimes(1);

      commandClearSpy.mockRestore();
      queryClearSpy.mockRestore();
      eventClearSpy.mockRestore();
      registryClearSpy.mockRestore();
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
        return this.props.children.map((child) =>
          h(FailChildLeaf, { label: child.label, fail: child.fail }, child.key)
        );
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
