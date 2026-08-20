/**
 * Resilience tests for transactional bus wiring.
 *
 * @module Effectable/runtime/BusDecorators.resilience.test
 */

import {
  OnCommand,
  OnEvent,
  OnQuery,
  createRuntimeBuses,
  wireRuntimeBuses,
  wireRuntimeBusesAll,
} from 'Effectable';
import type { RuntimeCommand, RuntimeEvent, RuntimeQuery } from 'Effectable';

type TC1 = RuntimeCommand<'CMD_A', { value: number }>;
type TC2 = RuntimeCommand<'CMD_B', { value: number }>;
type TQ1 = RuntimeQuery<'QRY_A', { text: string }>;
type TQ2 = RuntimeQuery<'QRY_B', { text: string }>;
type TE1 = RuntimeEvent<'EVT_A', { flag: boolean }>;
type TE2 = RuntimeEvent<'EVT_B', { flag: boolean }>;

type TCommand = TC1 | TC2;
type TQuery = TQ1 | TQ2;
type TEvent = TE1 | TE2;

describe('BusDecorators resilience (issue #14)', () => {
  describe('wireRuntimeBuses: transactional registration', () => {
    it('FAIL-CMD: second command registration fails → first command unregistered (no zombie handlers)', async () => {
      const buses = createRuntimeBuses<TCommand, TQuery, TEvent>();

      class TwoCommands {
        @OnCommand('CMD_A')
        public async handleA (_cmd: TC1): Promise<string> {
          return 'A';
        }

        @OnCommand('CMD_B')
        public async handleB (_cmd: TC2): Promise<string> {
          return 'B';
        }
      }

      const instance = new TwoCommands();
      buses.commandBus.register('CMD_B' as TCommand['type'], async (_cmd) => 'existing');

      let wiringError: Error | null = null;
      try {
        wireRuntimeBuses(instance, buses);
      } catch (err) {
        wiringError = err as Error;
      }

      expect(wiringError).not.toBeNull();
      expect(wiringError?.message).toContain('Command handler is already registered: CMD_B');

      await expect(buses.commandBus.execute<string>({ type: 'CMD_A', payload: { value: 1 } }))
        .rejects.toThrow('Command handler is not registered: CMD_A');

      const cmdB = await buses.commandBus.execute<string>({ type: 'CMD_B', payload: { value: 2 } });
      expect(cmdB).toBe('existing');
    });

    it('FAIL-QRY: second query registration fails → first query unregistered', async () => {
      const buses = createRuntimeBuses<TCommand, TQuery, TEvent>();

      class TwoQueries {
        @OnQuery('QRY_A')
        public handleA (_q: TQ1): number {
          return 10;
        }

        @OnQuery('QRY_B')
        public handleB (_q: TQ2): number {
          return 20;
        }
      }

      const instance = new TwoQueries();
      buses.queryBus.register('QRY_B' as TQuery['type'], (_q) => 999);

      let wiringError: Error | null = null;
      try {
        wireRuntimeBuses(instance, buses);
      } catch (err) {
        wiringError = err as Error;
      }

      expect(wiringError).not.toBeNull();
      expect(wiringError?.message).toContain('Query handler is already registered: QRY_B');

      await expect(buses.queryBus.execute<number>({ type: 'QRY_A', payload: { text: 'test' } }))
        .rejects.toThrow('Query handler is not registered: QRY_A');

      const qryB = await buses.queryBus.execute<number>({ type: 'QRY_B', payload: { text: 'test' } });
      expect(qryB).toBe(999);
    });

    it('FAIL-EVT: event subscription after command fails → command unregistered', async () => {
      const buses = createRuntimeBuses<TCommand, TQuery, TEvent>();

      class CommandAndEvent {
        @OnCommand('CMD_A')
        public async handleCmd (_cmd: TC1): Promise<string> {
          return 'cmdA';
        }

        @OnEvent('EVT_A')
        public onEvent (_evt: TE1): void {
          // noop
        }
      }

      const instance = new CommandAndEvent();
      const originalSubscribe = buses.eventBus.subscribe.bind(buses.eventBus);
      buses.eventBus.subscribe = ((_type: unknown, _handler: unknown) => {
        throw new Error('EventBus.subscribe forced failure');
      }) as typeof buses.eventBus.subscribe;

      let wiringError: Error | null = null;
      try {
        wireRuntimeBuses(instance, buses);
      } catch (err) {
        wiringError = err as Error;
      }

      buses.eventBus.subscribe = originalSubscribe;

      expect(wiringError).not.toBeNull();
      expect(wiringError?.message).toBe('EventBus.subscribe forced failure');

      await expect(buses.commandBus.execute<string>({ type: 'CMD_A', payload: { value: 1 } }))
        .rejects.toThrow('Command handler is not registered: CMD_A');
    });

    it('FAIL-VALIDATION: validation error before registration → no handlers registered', () => {
      const buses = createRuntimeBuses<TCommand, TQuery, TEvent>();

      class BrokenHandler {
        @OnCommand('CMD_A')
        public handleCmd (_cmd: TC1): Promise<string> {
          return Promise.resolve('never');
        }
      }

      const instance = new BrokenHandler();
      Object.defineProperty(instance, 'handleCmd', { value: 'not-a-function', writable: true, configurable: true });

      let wiringError: Error | null = null;
      try {
        wireRuntimeBuses(instance, buses);
      } catch (err) {
        wiringError = err as Error;
      }

      expect(wiringError).not.toBeNull();
      expect(wiringError?.message).toContain('OnCommand handler is not a function');
    });

    it('UNWIND-ERROR: cleanup disposer throws → preserves primary wiring error and reports cleanup errors', () => {
      const buses = createRuntimeBuses<TCommand, TQuery, TEvent>();

      class TwoCommands {
        @OnCommand('CMD_A')
        public async handleA (_cmd: TC1): Promise<string> {
          return 'A';
        }

        @OnCommand('CMD_B')
        public async handleB (_cmd: TC2): Promise<string> {
          return 'B';
        }
      }

      const instance = new TwoCommands();
      const originalRegister = buses.commandBus.register.bind(buses.commandBus);
      let callCount = 0;

      buses.commandBus.register = ((type: string, handler: unknown) => {
        callCount += 1;
        if (callCount === 1) {
          const disposer = originalRegister(type as TCommand['type'], handler as any);
          return () => {
            disposer();
            throw new Error('Cleanup disposer threw');
          };
        }
        throw new Error('Second registration fails');
      }) as typeof buses.commandBus.register;

      let wiringError: (Error & { cleanupErrors?: Error[] }) | null = null;
      try {
        wireRuntimeBuses(instance, buses);
      } catch (err) {
        wiringError = err as Error & { cleanupErrors?: Error[] };
      }

      buses.commandBus.register = originalRegister;

      expect(wiringError).not.toBeNull();
      expect(wiringError?.message).toBe('Second registration fails');
      expect(wiringError?.cleanupErrors).toBeDefined();
      expect(wiringError?.cleanupErrors?.length).toBe(1);
      expect(wiringError?.cleanupErrors?.[0].message).toBe('Cleanup disposer threw');
    });
  });

  describe('wireRuntimeBuses: idempotent disposer', () => {
    it('IDEMPOTENT: calling disposer twice is safe (no double-unregister)', async () => {
      const buses = createRuntimeBuses<TCommand, TQuery, TEvent>();

      class SingleCommand {
        @OnCommand('CMD_A')
        public async handleA (_cmd: TC1): Promise<string> {
          return 'A';
        }
      }

      const instance = new SingleCommand();
      const dispose = wireRuntimeBuses(instance, buses);

      const cmdA: TC1 = { type: 'CMD_A', payload: { value: 1 } };
      await buses.commandBus.execute<string>(cmdA);

      dispose();
      await expect(buses.commandBus.execute<string>(cmdA)).rejects.toThrow();

      expect(() => dispose()).not.toThrow();
      await expect(buses.commandBus.execute<string>(cmdA)).rejects.toThrow();
    });

    it('DISPOSER-ERROR: disposer cleanup error is thrown with aggregate message', () => {
      const buses = createRuntimeBuses<TCommand, TQuery, TEvent>();

      class SingleCommand {
        @OnCommand('CMD_A')
        public async handleA (_cmd: TC1): Promise<string> {
          return 'A';
        }
      }

      const instance = new SingleCommand();
      const originalRegister = buses.commandBus.register.bind(buses.commandBus);

      buses.commandBus.register = ((type: string, handler: unknown) => {
        const originalDisposer = originalRegister(type as TCommand['type'], handler as any);
        return () => {
          originalDisposer();
          throw new Error('Disposer cleanup error');
        };
      }) as typeof buses.commandBus.register;

      const dispose = wireRuntimeBuses(instance, buses);
      buses.commandBus.register = originalRegister;

      let cleanupError: (Error & { cleanupErrors?: Error[] }) | null = null;
      try {
        dispose();
      } catch (err) {
        cleanupError = err as Error & { cleanupErrors?: Error[] };
      }

      expect(cleanupError).not.toBeNull();
      expect(cleanupError?.message).toContain('disposer cleanup encountered 1 error(s)');
      expect(cleanupError?.cleanupErrors).toBeDefined();
      expect(cleanupError?.cleanupErrors?.length).toBe(1);
      expect(cleanupError?.cleanupErrors?.[0].message).toBe('Disposer cleanup error');
    });
  });

  describe('wireRuntimeBusesAll: transactional multi-instance wiring', () => {
    it('MULTI-FAIL: second instance wiring fails → first instance unwound', async () => {
      const buses = createRuntimeBuses<TCommand, TQuery, TEvent>();

      class FirstInstance {
        @OnCommand('CMD_A')
        public async handleA (_cmd: TC1): Promise<string> {
          return 'first';
        }
      }

      class SecondInstance {
        @OnCommand('CMD_B')
        public async handleB (_cmd: TC2): Promise<string> {
          return 'second';
        }
      }

      buses.commandBus.register('CMD_B' as TCommand['type'], async (_cmd) => 'pre-existing');

      const first = new FirstInstance();
      const second = new SecondInstance();

      let wiringError: Error | null = null;
      try {
        wireRuntimeBusesAll(buses, [first, second]);
      } catch (err) {
        wiringError = err as Error;
      }

      expect(wiringError).not.toBeNull();
      expect(wiringError?.message).toContain('Command handler is already registered: CMD_B');

      await expect(buses.commandBus.execute<string>({ type: 'CMD_A', payload: { value: 1 } }))
        .rejects.toThrow('Command handler is not registered: CMD_A');

      const cmdB = await buses.commandBus.execute<string>({ type: 'CMD_B', payload: { value: 2 } });
      expect(cmdB).toBe('pre-existing');
    });

    it('MULTI-THIRD-FAIL: third instance fails → first and second unwound', async () => {
      const buses = createRuntimeBuses<TCommand, TQuery, TEvent>();

      class First {
        @OnCommand('CMD_A')
        public async handleA (_cmd: TC1): Promise<string> {
          return 'first';
        }
      }

      class Second {
        @OnQuery('QRY_A')
        public handleQ (_q: TQ1): number {
          return 200;
        }
      }

      class Third {
        @OnCommand('CMD_B')
        public async handleB (_cmd: TC2): Promise<string> {
          return 'third';
        }
      }

      buses.commandBus.register('CMD_B' as TCommand['type'], async (_cmd) => 'blocker');

      const instances = [new First(), new Second(), new Third()];

      let wiringError: Error | null = null;
      try {
        wireRuntimeBusesAll(buses, instances);
      } catch (err) {
        wiringError = err as Error;
      }

      expect(wiringError).not.toBeNull();

      await expect(buses.commandBus.execute<string>({ type: 'CMD_A', payload: { value: 1 } }))
        .rejects.toThrow('Command handler is not registered: CMD_A');
      await expect(buses.queryBus.execute<number>({ type: 'QRY_A', payload: { text: 'test' } }))
        .rejects.toThrow('Query handler is not registered: QRY_A');

      const cmdB = await buses.commandBus.execute<string>({ type: 'CMD_B', payload: { value: 2 } });
      expect(cmdB).toBe('blocker');
    });

    it('MULTI-IDEMPOTENT: wireRuntimeBusesAll disposer is idempotent', async () => {
      const buses = createRuntimeBuses<TCommand, TQuery, TEvent>();

      class First {
        @OnCommand('CMD_A')
        public async handleA (_cmd: TC1): Promise<string> {
          return 'A';
        }
      }

      class Second {
        @OnQuery('QRY_A')
        public handleQ (_q: TQ1): number {
          return 42;
        }
      }

      const dispose = wireRuntimeBusesAll(buses, [new First(), new Second()]);

      await buses.commandBus.execute<string>({ type: 'CMD_A', payload: { value: 1 } });
      await buses.queryBus.execute<number>({ type: 'QRY_A', payload: { text: 'test' } });

      dispose();

      await expect(buses.commandBus.execute<string>({ type: 'CMD_A', payload: { value: 1 } }))
        .rejects.toThrow();
      await expect(buses.queryBus.execute<number>({ type: 'QRY_A', payload: { text: 'test' } }))
        .rejects.toThrow();

      expect(() => dispose()).not.toThrow();
    });

    it('MULTI-CLEANUP-ERROR: wireRuntimeBusesAll disposer cleanup error is aggregated', () => {
      const buses = createRuntimeBuses<TCommand, TQuery, TEvent>();

      class First {
        @OnCommand('CMD_A')
        public async handleA (_cmd: TC1): Promise<string> {
          return 'A';
        }
      }

      const originalRegister = buses.commandBus.register.bind(buses.commandBus);
      buses.commandBus.register = ((type: string, handler: unknown) => {
        const originalDisposer = originalRegister(type as TCommand['type'], handler as any);
        return () => {
          originalDisposer();
          throw new Error('Multi-disposer cleanup error');
        };
      }) as typeof buses.commandBus.register;

      const dispose = wireRuntimeBusesAll(buses, [new First()]);
      buses.commandBus.register = originalRegister;

      let cleanupError: (Error & { cleanupErrors?: Error[] }) | null = null;
      try {
        dispose();
      } catch (err) {
        cleanupError = err as Error & { cleanupErrors?: Error[] };
      }

      expect(cleanupError).not.toBeNull();
      expect(cleanupError?.message).toContain('wireRuntimeBusesAll: disposer cleanup encountered 1 error(s)');
      expect(cleanupError?.cleanupErrors).toBeDefined();
      expect(cleanupError?.cleanupErrors?.length).toBe(1);
    });
  });

  describe('external buses: no zombie handlers after failure', () => {
    it('EXTERNAL-CLEAN: caller-owned buses have no handlers after failed wiring', async () => {
      const externalBuses = createRuntimeBuses<TCommand, TQuery, TEvent>();

      class FailingWire {
        @OnCommand('CMD_A')
        public async handleA (_cmd: TC1): Promise<string> {
          return 'A';
        }

        @OnQuery('QRY_A')
        public handleQ (_q: TQ1): number {
          return 10;
        }

        @OnEvent('EVT_A')
        public onEventA (_evt: TE1): void {
          // noop
        }

        @OnEvent('EVT_B')
        public onEventB (_evt: TE2): void {
          // noop
        }
      }

      const instance = new FailingWire();
      const originalEventSubscribe = externalBuses.eventBus.subscribe.bind(externalBuses.eventBus);
      let subscribeCallCount = 0;

      externalBuses.eventBus.subscribe = ((type: unknown, handler: unknown) => {
        subscribeCallCount += 1;
        if (subscribeCallCount === 1) {
          return originalEventSubscribe(type as TEvent['type'], handler as any);
        }
        throw new Error('EventBus subscription forced failure');
      }) as typeof externalBuses.eventBus.subscribe;

      let wiringError: Error | null = null;
      try {
        wireRuntimeBuses(instance, externalBuses);
      } catch (err) {
        wiringError = err as Error;
      }

      externalBuses.eventBus.subscribe = originalEventSubscribe;

      expect(wiringError).not.toBeNull();
      expect(wiringError?.message).toBe('EventBus subscription forced failure');

      await expect(externalBuses.commandBus.execute<string>({ type: 'CMD_A', payload: { value: 1 } }))
        .rejects.toThrow('Command handler is not registered: CMD_A');
      await expect(externalBuses.queryBus.execute<number>({ type: 'QRY_A', payload: { text: 'test' } }))
        .rejects.toThrow('Query handler is not registered: QRY_A');

      let eventHitsA = 0;
      let eventHitsB = 0;
      externalBuses.eventBus.subscribe('EVT_A' as TEvent['type'], (_evt) => {
        eventHitsA += 1;
      });
      externalBuses.eventBus.subscribe('EVT_B' as TEvent['type'], (_evt) => {
        eventHitsB += 1;
      });
      externalBuses.eventBus.publish({ type: 'EVT_A', payload: { flag: true } });
      externalBuses.eventBus.publish({ type: 'EVT_B', payload: { flag: false } });

      expect(eventHitsA).toBe(1);
      expect(eventHitsB).toBe(1);
    });
  });
});
