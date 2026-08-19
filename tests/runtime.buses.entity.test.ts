/**
 * Entity tests for CommandBus, QueryBus, EventBus (M01–M07).
 *
 * @module Effectable/runtime.buses.entity.test
 */

import { CommandBus, EventBus, QueryBus } from 'Effectable';
import type {
  RuntimeCommand,
  RuntimeCommandHandlerContract,
  RuntimeEvent,
  RuntimeQuery,
  RuntimeQueryHandlerContract,
} from 'Effectable';

type TestCommand = RuntimeCommand<'CMD_A', { v: number }>;
type TestQuery = RuntimeQuery<'QRY_B', { s: string }>;
type TestEvent = RuntimeEvent<'EVT_C', { flag: boolean }>;

describe('CommandBus', () => {
  it('RT-08: sync handler returns a value via execute', async () => {
    const bus = new CommandBus<TestCommand>();
    bus.register('CMD_A', (command) => {
      return command.payload.v * 2;
    });

    const result = await bus.execute<number>({ type: 'CMD_A', payload: { v: 7 } });
    expect(result).toBe(14);
  });

  it('M01: register, execute and dispose remove the handler', async () => {
    const bus = new CommandBus<TestCommand>();
    let hits = 0;

    const dispose = bus.register('CMD_A', async (command) => {
      hits += command.payload.v;
      return hits;
    });

    const cmd: TestCommand = { type: 'CMD_A', payload: { v: 3 } };
    const result = await bus.execute<number>(cmd);
    expect(result).toBe(3);
    expect(hits).toBe(3);

    dispose();
    await expect(bus.execute(cmd)).rejects.toThrow('Command handler is not registered: CMD_A');
  });

  it('M04: execute without a handler throws', async () => {
    const bus = new CommandBus<TestCommand>();
    const cmd: TestCommand = { type: 'CMD_A', payload: { v: 1 } };
    await expect(bus.execute(cmd)).rejects.toThrow('Command handler is not registered: CMD_A');
  });

  it('repeated register for the same type throws', () => {
    const bus = new CommandBus<TestCommand>();
    bus.register('CMD_A', async () => 'a');
    expect(() => {
      bus.register('CMD_A', async () => 'b');
    }).toThrow('Command handler is already registered: CMD_A');
  });

  it('double dispose of registration is safe', async () => {
    const bus = new CommandBus<TestCommand>();
    const dispose = bus.register('CMD_A', async () => 'ok');
    dispose();
    expect(() => {
      dispose();
    }).not.toThrow();
    await expect(bus.execute({ type: 'CMD_A', payload: { v: 0 } })).rejects.toThrow();
  });

  it('clear removes all handlers', async () => {
    const bus = new CommandBus<TestCommand>();
    bus.register('CMD_A', async () => 'x');
    bus.clear();
    await expect(bus.execute({ type: 'CMD_A', payload: { v: 0 } })).rejects.toThrow();
  });

  it('RT-06: unregister(type) removes the handler directly without disposer', async () => {
    const bus = new CommandBus<TestCommand>();
    bus.register('CMD_A', async () => 'before');
    const cmd: TestCommand = { type: 'CMD_A', payload: { v: 0 } };
    expect(await bus.execute<string>(cmd)).toBe('before');

    bus.unregister('CMD_A');
    await expect(bus.execute(cmd)).rejects.toThrow('Command handler is not registered: CMD_A');
  });

  it('RT-07: handler throw and reject are rethrown from execute', async () => {
    const busThrow = new CommandBus<TestCommand>();
    busThrow.register('CMD_A', async () => {
      throw new Error('command sync throw');
    });
    const cmd: TestCommand = { type: 'CMD_A', payload: { v: 1 } };
    await expect(busThrow.execute(cmd)).rejects.toThrow('command sync throw');

    const busReject = new CommandBus<TestCommand>();
    busReject.register('CMD_A', async () => {
      return Promise.reject(new Error('command async reject'));
    });
    await expect(busReject.execute(cmd)).rejects.toThrow('command async reject');
  });

  it('stale command disposer after clear() + re-register does not remove the new handler', async () => {
    const bus = new CommandBus<TestCommand>();
    const handlerA = async (): Promise<string> => 'A';
    const handlerB = async (): Promise<string> => 'B';
    const cmd: TestCommand = { type: 'CMD_A', payload: { v: 0 } };

    const disposeA = bus.register('CMD_A', handlerA);
    bus.clear();
    bus.register('CMD_A', handlerB);

    disposeA();

    expect(await bus.execute<string>(cmd)).toBe('B');
  });

  it('repeated command disposal is a no-op and does not remove a re-registered handler', async () => {
    const bus = new CommandBus<TestCommand>();
    const handlerA = async (): Promise<string> => 'A';
    const handlerB = async (): Promise<string> => 'B';
    const cmd: TestCommand = { type: 'CMD_A', payload: { v: 0 } };

    const disposeA = bus.register('CMD_A', handlerA);
    disposeA();
    disposeA();

    bus.register('CMD_A', handlerB);
    disposeA();

    expect(await bus.execute<string>(cmd)).toBe('B');
  });

  it('disposal after command bus clear is a no-op before re-register', async () => {
    const bus = new CommandBus<TestCommand>();
    const disposeA = bus.register('CMD_A', async () => 'A');
    bus.clear();
    disposeA();

    await expect(bus.execute({ type: 'CMD_A', payload: { v: 0 } })).rejects.toThrow(
      'Command handler is not registered: CMD_A'
    );
  });
});

describe('QueryBus', () => {
  it('M02: register, execute and dispose remove the handler', async () => {
    const bus = new QueryBus<TestQuery>();
    const dispose = bus.register('QRY_B', (query) => {
      return query.payload.s.length;
    });

    const q: TestQuery = { type: 'QRY_B', payload: { s: 'abcd' } };
    expect(await bus.execute<number>(q)).toBe(4);

    dispose();
    await expect(bus.execute(q)).rejects.toThrow('Query handler is not registered: QRY_B');
  });

  it('M04: execute without a handler throws', async () => {
    const bus = new QueryBus<TestQuery>();
    const q: TestQuery = { type: 'QRY_B', payload: { s: 'x' } };
    await expect(bus.execute(q)).rejects.toThrow('Query handler is not registered: QRY_B');
  });

  it('double dispose of registration is safe', async () => {
    const bus = new QueryBus<TestQuery>();
    const dispose = bus.register('QRY_B', () => 1);
    dispose();
    expect(() => {
      dispose();
    }).not.toThrow();
  });

  it('BUS-04: repeated register for the same type throws', () => {
    const bus = new QueryBus<TestQuery>();
    bus.register('QRY_B', () => 1);
    expect(() => {
      bus.register('QRY_B', () => 2);
    }).toThrow('Query handler is already registered: QRY_B');
  });

  it('BUS-05: clear removes all handlers', async () => {
    const bus = new QueryBus<TestQuery>();
    bus.register('QRY_B', () => 99);
    bus.clear();
    const q: TestQuery = { type: 'QRY_B', payload: { s: 'x' } };
    await expect(bus.execute(q)).rejects.toThrow('Query handler is not registered: QRY_B');
  });

  it('BUS-06: async handler reject is rethrown from execute', async () => {
    const bus = new QueryBus<TestQuery>();
    bus.register('QRY_B', async () => {
      return Promise.reject(new Error('query async fail'));
    });
    const q: TestQuery = { type: 'QRY_B', payload: { s: 'z' } };
    await expect(bus.execute(q)).rejects.toThrow('query async fail');
  });

  it('stale query disposer after unregister/re-register does not remove the new handler', async () => {
    const bus = new QueryBus<TestQuery>();
    const handlerA = (): number => 1;
    const handlerB = (): number => 2;
    const q: TestQuery = { type: 'QRY_B', payload: { s: 'x' } };

    const disposeA = bus.register('QRY_B', handlerA);
    bus.unregister('QRY_B');
    bus.register('QRY_B', handlerB);

    disposeA();

    expect(await bus.execute<number>(q)).toBe(2);
  });

  it('repeated query disposal is a no-op and does not remove a re-registered handler', async () => {
    const bus = new QueryBus<TestQuery>();
    const handlerA = (): number => 1;
    const handlerB = (): number => 2;
    const q: TestQuery = { type: 'QRY_B', payload: { s: 'x' } };

    const disposeA = bus.register('QRY_B', handlerA);
    disposeA();
    disposeA();

    bus.register('QRY_B', handlerB);
    disposeA();

    expect(await bus.execute<number>(q)).toBe(2);
  });

  it('disposal after query bus clear does not delete a later re-registration', async () => {
    const bus = new QueryBus<TestQuery>();
    const handlerA = (): number => 1;
    const handlerB = (): number => 2;
    const q: TestQuery = { type: 'QRY_B', payload: { s: 'x' } };

    const disposeA = bus.register('QRY_B', handlerA);
    bus.clear();
    bus.register('QRY_B', handlerB);

    disposeA();

    expect(await bus.execute<number>(q)).toBe(2);
  });
});

describe('EventBus', () => {
  it('M03/M05: typed subscribe, subscribeAll, unsubscribe and clear', () => {
    const bus = new EventBus<TestEvent>();
    const typed: TestEvent[] = [];
    const all: TestEvent[] = [];

    const offTyped = bus.subscribe('EVT_C', (event) => {
      typed.push(event);
    });
    const offAll = bus.subscribeAll((event) => {
      all.push(event);
    });

    const ev: TestEvent = { type: 'EVT_C', payload: { flag: true } };
    bus.publish(ev);
    expect(typed).toEqual([ev]);
    expect(all).toEqual([ev]);

    offTyped();
    bus.publish(ev);
    expect(typed).toEqual([ev]);
    expect(all).toEqual([ev, ev]);

    offAll();
    bus.publish(ev);
    expect(all).toEqual([ev, ev]);

    bus.subscribe('EVT_C', (event) => {
      typed.push(event);
    });
    bus.clear();
    bus.publish(ev);
    expect(typed).toEqual([ev]);
  });

  it('M06: EventBus does not catch throw — subsequent handlers are not called', () => {
    const bus = new EventBus<TestEvent>();
    const order: string[] = [];

    bus.subscribe('EVT_C', () => {
      order.push('first');
      throw new Error('handler boom');
    });
    bus.subscribe('EVT_C', () => {
      order.push('second');
    });
    bus.subscribeAll(() => {
      order.push('all');
    });

    expect(() => {
      bus.publish({ type: 'EVT_C', payload: { flag: false } });
    }).toThrow('handler boom');

    expect(order).toEqual(['first']);
  });

  it('M07: unsubscribing during publish does not break the bus', () => {
    const bus = new EventBus<TestEvent>();
    const hits: string[] = [];

    const removeSecond = bus.subscribe('EVT_C', () => {
      hits.push('second');
    });

    bus.subscribe('EVT_C', () => {
      hits.push('first');
      removeSecond();
    });

    bus.subscribe('EVT_C', () => {
      hits.push('third');
    });

    bus.publish({ type: 'EVT_C', payload: { flag: true } });

    expect(hits).toContain('first');
    expect(hits).toContain('third');
  });

  it('double dispose of subscription is safe', () => {
    const bus = new EventBus<TestEvent>();
    let n = 0;
    const off = bus.subscribe('EVT_C', () => {
      n += 1;
    });
    off();
    expect(() => {
      off();
    }).not.toThrow();
    bus.publish({ type: 'EVT_C', payload: { flag: true } });
    expect(n).toBe(0);
  });

  it('BUS-14: multiple typed subscribers for one type receive publish (fan-out)', () => {
    const bus = new EventBus<TestEvent>();
    const hits: number[] = [];

    bus.subscribe('EVT_C', () => {
      hits.push(1);
    });
    bus.subscribe('EVT_C', () => {
      hits.push(2);
    });
    bus.subscribe('EVT_C', () => {
      hits.push(3);
    });

    const ev: TestEvent = { type: 'EVT_C', payload: { flag: true } };
    bus.publish(ev);

    expect(hits).toEqual([1, 2, 3]);
  });

  it('BUS-12: publish with no subscribers — noop without throw', () => {
    const bus = new EventBus<TestEvent>();
    expect(() => {
      bus.publish({ type: 'EVT_C', payload: { flag: false } });
    }).not.toThrow();
  });

  it('BUS-13: unsubscribe for unknown type — noop without throw', () => {
    const bus = new EventBus<TestEvent>();
    const orphan = (): void => {
      return;
    };
    expect(() => {
      bus.unsubscribe('EVT_C', orphan);
    }).not.toThrow();
  });

  it('BUS-11: throw in subscribeAll does not call subsequent any-handlers', () => {
    const bus = new EventBus<TestEvent>();
    const order: string[] = [];

    bus.subscribeAll(() => {
      order.push('all-first');
      throw new Error('subscribeAll boom');
    });
    bus.subscribeAll(() => {
      order.push('all-second');
    });

    expect(() => {
      bus.publish({ type: 'EVT_C', payload: { flag: true } });
    }).toThrow('subscribeAll boom');

    expect(order).toEqual(['all-first']);
  });
});

describe('RT-17 runtime handler contracts (types-only)', () => {
  it('RT-17: RuntimeCommandHandlerContract / RuntimeQueryHandlerContract are usable as types', async () => {
    const commandHandler: RuntimeCommandHandlerContract<TestCommand, number> = {
      getCommandType (): TestCommand['type'] {
        return 'CMD_A';
      },
      execute (command: TestCommand): number {
        return command.payload.v;
      },
    };

    const queryHandler: RuntimeQueryHandlerContract<TestQuery, string> = {
      getQueryType (): TestQuery['type'] {
        return 'QRY_B';
      },
      execute (query: TestQuery): string {
        return query.payload.s;
      },
    };

    expect(commandHandler.getCommandType()).toBe('CMD_A');
    expect(commandHandler.execute({ type: 'CMD_A', payload: { v: 9 } })).toBe(9);
    expect(queryHandler.getQueryType()).toBe('QRY_B');
    expect(await Promise.resolve(queryHandler.execute({ type: 'QRY_B', payload: { s: 'ok' } }))).toBe('ok');
  });
});
