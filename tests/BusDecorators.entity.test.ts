/**
 * Entity tests for runtime bus decorators and wireRuntimeBuses.
 *
 * @module Effectable/runtime/BusDecorators.entity.test
 */

import {
  OnCommand,
  OnEvent,
  OnQuery,
  UseCommandBus,
  UseEventBus,
  UseQueryBus,
  createRuntimeBuses,
  instanceUsesRuntimeBusDecorators,
  wireRuntimeBuses,
  wireRuntimeBusesAll,
  wireRuntimeBusesIfDecorated,
} from 'Effectable';
import type { RuntimeCommand, RuntimeEvent, RuntimeQuery } from 'Effectable';

type TC = RuntimeCommand<'X', { n: number }>;
type TQ = RuntimeQuery<'Y', { s: string }>;
type TE = RuntimeEvent<'Z', { z: boolean }>;

class CommandTarget {
  public last: TC | null = null;

  @OnCommand('X')
  public async handleX (command: TC): Promise<string> {
    this.last = command;
    return 'ok';
  }
}

class QueryTarget {
  @OnQuery('Y')
  public handleY (query: TQ): number {
    return query.payload.s.length;
  }
}

class EventTarget {
  public hits = 0;

  @OnEvent('Z')
  public onZ (_event: TE): void {
    this.hits += 1;
  }
}

class InjectTarget {
  @UseCommandBus()
  public commandBus!: ReturnType<typeof createRuntimeBuses<TC, TQ, TE>>['commandBus'];
  @UseQueryBus()
  public queryBus!: ReturnType<typeof createRuntimeBuses<TC, TQ, TE>>['queryBus'];
  @UseEventBus()
  public eventBus!: ReturnType<typeof createRuntimeBuses<TC, TQ, TE>>['eventBus'];
}

describe('BusDecorators', () => {
  it('createRuntimeBuses creates three independent buses', () => {
    const a = createRuntimeBuses<TC, TQ, TE>();
    const b = createRuntimeBuses<TC, TQ, TE>();
    expect(a.commandBus).not.toBe(b.commandBus);
    expect(a.queryBus).not.toBe(b.queryBus);
    expect(a.eventBus).not.toBe(b.eventBus);
  });

  it('wireRuntimeBuses registers OnCommand and runs execute', async () => {
    const buses = createRuntimeBuses<TC, TQ, TE>();
    const target = new CommandTarget();
    const dispose = wireRuntimeBuses(target, buses);
    const cmd: TC = { type: 'X', payload: { n: 7 } };
    const result = await buses.commandBus.execute<string>(cmd);
    expect(result).toBe('ok');
    expect(target.last).toEqual(cmd);
    dispose();
  });

  it('wireRuntimeBuses registers OnQuery', async () => {
    const buses = createRuntimeBuses<TC, TQ, TE>();
    const target = new QueryTarget();
    const dispose = wireRuntimeBuses(target, buses);
    const q: TQ = { type: 'Y', payload: { s: 'abc' } };
    const result = await buses.queryBus.execute<number>(q);
    expect(result).toBe(3);
    dispose();
  });

  it('wireRuntimeBuses subscribes OnEvent', () => {
    const buses = createRuntimeBuses<TC, TQ, TE>();
    const target = new EventTarget();
    const dispose = wireRuntimeBuses(target, buses);
    const ev: TE = { type: 'Z', payload: { z: true } };
    buses.eventBus.publish(ev);
    expect(target.hits).toBe(1);
    dispose();
  });

  it('wireRuntimeBuses injects Use*Bus fields', () => {
    const buses = createRuntimeBuses<TC, TQ, TE>();
    const target = new InjectTarget();
    const dispose = wireRuntimeBuses(target, buses);
    expect(target.commandBus).toBe(buses.commandBus);
    expect(target.queryBus).toBe(buses.queryBus);
    expect(target.eventBus).toBe(buses.eventBus);
    dispose();
  });

  it('wireRuntimeBusesAll wires multiple instances to one bundle and dispose removes all', async () => {
    const buses = createRuntimeBuses<TC, TQ, TE>();
    const cmdT = new CommandTarget();
    const qT = new QueryTarget();
    const disposeAll = wireRuntimeBusesAll(buses, [cmdT, qT]);

    const cmd: TC = { type: 'X', payload: { n: 1 } };
    await buses.commandBus.execute<string>(cmd);
    expect(cmdT.last).toEqual(cmd);

    const q: TQ = { type: 'Y', payload: { s: 'hi' } };
    const len = await buses.queryBus.execute<number>(q);
    expect(len).toBe(2);

    disposeAll();

    await expect(buses.commandBus.execute<string>(cmd)).rejects.toThrow();
    await expect(buses.queryBus.execute<number>(q)).rejects.toThrow();
  });

  it('N07: wireRuntimeBusesIfDecorated on an undecorated instance returns null', () => {
    const buses = createRuntimeBuses<TC, TQ, TE>();
    class PlainHost {
      public value = 1;
    }
    const instance = new PlainHost();
    expect(wireRuntimeBusesIfDecorated(instance, buses)).toBeNull();
  });

  it('DEC-08: wireRuntimeBusesIfDecorated on a decorated instance returns disposer and OnCommand works', async () => {
    const buses = createRuntimeBuses<TC, TQ, TE>();
    const target = new CommandTarget();
    const dispose = wireRuntimeBusesIfDecorated(target, buses);
    expect(dispose).not.toBeNull();
    if (dispose === null) {
      throw new Error('expected non-null disposer');
    }

    const cmd: TC = { type: 'X', payload: { n: 42 } };
    const result = await buses.commandBus.execute<string>(cmd);
    expect(result).toBe('ok');
    expect(target.last).toEqual(cmd);

    dispose();
  });

  it('DEC-10: inheritance merge/override base→leaf for @OnCommand', async () => {
    class BaseCmd {
      public from: 'base' | 'leaf' = 'base';

      @OnCommand('X')
      public async handleX (_command: TC): Promise<string> {
        this.from = 'base';
        return 'base';
      }
    }

    class LeafCmd extends BaseCmd {
      @OnCommand('X')
      public override async handleX (_command: TC): Promise<string> {
        this.from = 'leaf';
        return 'leaf';
      }
    }

    const buses = createRuntimeBuses<TC, TQ, TE>();
    const target = new LeafCmd();
    const dispose = wireRuntimeBuses(target, buses);
    const cmd: TC = { type: 'X', payload: { n: 0 } };
    const result = await buses.commandBus.execute<string>(cmd);
    expect(result).toBe('leaf');
    expect(target.from).toBe('leaf');
    dispose();
  });

  it('DEC-11: OnCommand points to a non-function — wireRuntimeBuses throws', () => {
    class BrokenCmdHost {
      @OnCommand('X')
      public handleX (_command: TC): Promise<string> {
        return Promise.resolve('never');
      }
    }

    const buses = createRuntimeBuses<TC, TQ, TE>();
    const target = new BrokenCmdHost();
    Object.defineProperty(target, 'handleX', { value: 'not-a-handler', writable: true, configurable: true });

    expect(() => {
      wireRuntimeBuses(target, buses);
    }).toThrow('wireRuntimeBuses: OnCommand handler is not a function: handleX');
  });

  it('DEC-13: after dispose OnCommand execute fails (handler removed)', async () => {
    const buses = createRuntimeBuses<TC, TQ, TE>();
    const target = new CommandTarget();
    const dispose = wireRuntimeBuses(target, buses);
    const cmd: TC = { type: 'X', payload: { n: 1 } };

    await buses.commandBus.execute<string>(cmd);
    expect(target.last).toEqual(cmd);

    dispose();
    await expect(buses.commandBus.execute<string>(cmd)).rejects.toThrow();
  });

  it('DEC-12: after dispose OnEvent does not receive publish', () => {
    const buses = createRuntimeBuses<TC, TQ, TE>();
    const target = new EventTarget();
    const dispose = wireRuntimeBuses(target, buses);
    const ev: TE = { type: 'Z', payload: { z: false } };

    buses.eventBus.publish(ev);
    expect(target.hits).toBe(1);

    dispose();
    buses.eventBus.publish(ev);
    expect(target.hits).toBe(1);
  });

  it('N08: instanceUsesRuntimeBusDecorators walks the prototype chain', () => {
    class BaseDecorated {
      @OnCommand('X')
      public async handleX (_command: TC): Promise<string> {
        return 'base';
      }
    }

    class ChildOfDecorated extends BaseDecorated {}

    class PlainBase {}

    class ChildOfPlain extends PlainBase {}

    expect(instanceUsesRuntimeBusDecorators(new ChildOfDecorated())).toBe(true);
    expect(instanceUsesRuntimeBusDecorators(new CommandTarget())).toBe(true);
    expect(instanceUsesRuntimeBusDecorators(new ChildOfPlain())).toBe(false);
    expect(instanceUsesRuntimeBusDecorators({})).toBe(false);
  });
});
