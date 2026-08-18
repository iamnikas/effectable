/**
 * Inheritance tests for decorator metadata.
 * Ensures that subclass decorators do not mutate parent metadata,
 * and that handlers are registered in correct order (base-to-derived).
 *
 * @module Effectable/decorator-metadata-inheritance.test
 */

import {
  OnCommand,
  OnEvent,
  UseCommandBus,
  UseQueryBus,
  createRuntimeBuses,
  wireRuntimeBuses,
} from 'Effectable';
import type { RuntimeCommand, RuntimeEvent, RuntimeQuery } from 'Effectable';

type TC = RuntimeCommand<'X' | 'Y', { n: number }>;
type TQ = RuntimeQuery<'A' | 'B', { s: string }>;
type TE = RuntimeEvent<'E1' | 'E2', { flag: boolean }>;

describe('BusDecorators metadata inheritance', () => {
  it('derived class can override base handler', async () => {
    class Base {
      @OnCommand('X')
      public async handleX (_command: TC): Promise<string> {
        return 'base';
      }
    }

    class Derived extends Base {
      @OnCommand('X')
      public override async handleX (_command: TC): Promise<string> {
        return 'derived';
      }
    }

    const buses = createRuntimeBuses<TC, TQ, TE>();
    const instance = new Derived();
    const dispose = wireRuntimeBuses(instance, buses);

    const result = await buses.commandBus.execute<string>({ type: 'X', payload: { n: 1 } });
    expect(result).toBe('derived');
    dispose();
  });

  it('does not register inherited handlers twice', async () => {
    let baseCallCount = 0;

    class Base {
      @OnCommand('X')
      public async handleX (_command: TC): Promise<string> {
        baseCallCount += 1;
        return 'base';
      }
    }

    class Derived extends Base {
      @OnCommand('Y')
      public async handleY (_command: TC): Promise<string> {
        return 'derived';
      }
    }

    const buses = createRuntimeBuses<TC, TQ, TE>();
    const instance = new Derived();
    const dispose = wireRuntimeBuses(instance, buses);

    await buses.commandBus.execute<string>({ type: 'X', payload: { n: 1 } });
    expect(baseCallCount).toBe(1);

    dispose();
  });

  it('parent metadata not mutated after subclass decorators', () => {
    class Base {
      @UseCommandBus()
      public commandBus!: ReturnType<typeof createRuntimeBuses<TC, TQ, TE>>['commandBus'];
    }

    class Derived extends Base {
      @UseQueryBus()
      public queryBus!: ReturnType<typeof createRuntimeBuses<TC, TQ, TE>>['queryBus'];
    }

    const buses = createRuntimeBuses<TC, TQ, TE>();
    const baseInstance = new Base();
    const derivedInstance = new Derived();

    wireRuntimeBuses(baseInstance, buses);
    wireRuntimeBuses(derivedInstance, buses);

    expect(baseInstance.commandBus).toBe(buses.commandBus);
    expect((baseInstance as any)['queryBus']).toBeUndefined();

    expect(derivedInstance.commandBus).toBe(buses.commandBus);
    expect(derivedInstance.queryBus).toBe(buses.queryBus);
  });

  it('siblings do not share metadata', async () => {
    class Base {
      @UseCommandBus()
      public commandBus!: ReturnType<typeof createRuntimeBuses<TC, TQ, TE>>['commandBus'];
    }

    class SiblingA extends Base {
      @OnCommand('X')
      public async handleX (_command: TC): Promise<string> {
        return 'siblingA';
      }
    }

    class SiblingB extends Base {
      @OnCommand('Y')
      public async handleY (_command: TC): Promise<string> {
        return 'siblingB';
      }
    }

    const buses = createRuntimeBuses<TC, TQ, TE>();
    const instanceA = new SiblingA();
    const instanceB = new SiblingB();

    const disposeA = wireRuntimeBuses(instanceA, buses);
    const disposeB = wireRuntimeBuses(instanceB, buses);

    const resultA = await buses.commandBus.execute<string>({ type: 'X', payload: { n: 1 } });
    const resultB = await buses.commandBus.execute<string>({ type: 'Y', payload: { n: 2 } });

    expect(resultA).toBe('siblingA');
    expect(resultB).toBe('siblingB');

    disposeA();
    disposeB();
  });

  it('three-level inheritance works correctly', async () => {
    const order: string[] = [];

    class GrandParent {
      @OnCommand('X')
      public async handleX (_command: TC): Promise<string> {
        order.push('GrandParent.handleX');
        return 'grandparent';
      }
    }

    class Parent extends GrandParent {
      @OnCommand('Y')
      public async handleY (_command: TC): Promise<string> {
        order.push('Parent.handleY');
        return 'parent';
      }
    }

    class Child extends Parent {
      @OnEvent('E1')
      public onE1 (_event: TE): void {
        order.push('Child.onE1');
      }
    }

    const buses = createRuntimeBuses<TC, TQ, TE>();
    const instance = new Child();
    const dispose = wireRuntimeBuses(instance, buses);

    await buses.commandBus.execute<string>({ type: 'X', payload: { n: 1 } });
    await buses.commandBus.execute<string>({ type: 'Y', payload: { n: 2 } });
    buses.eventBus.publish({ type: 'E1', payload: { flag: true } });

    expect(order).toEqual(['GrandParent.handleX', 'Parent.handleY', 'Child.onE1']);
    dispose();
  });
});
