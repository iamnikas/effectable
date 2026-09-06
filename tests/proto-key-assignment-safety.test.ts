/**
 * Regression: dynamic `__proto__` key assignment must not invoke the
 * Object.prototype `__proto__` setter (prototype pollution / lost keys).
 *
 * Covers Component.setState mutableState fast-path and BusDecorators
 * `@Use*Bus` field injection — same class of bug as store/connect #109.
 */
import {
  Component,
  UseCommandBus,
  createRuntimeBuses,
  wireRuntimeBuses,
} from 'Effectable';
import type { RuntimeCommand, RuntimeEvent, RuntimeQuery } from 'Effectable';

describe('__proto__ key assignment safety (mutableState + bus inject)', () => {
  test('mutableState setState: JSON __proto__ stays an own state field', () => {
    class Host extends Component<{ count: number }, Record<string, never>> {
      public static override readonly mutableState = true;

      constructor () {
        super({});
        this.state = { count: 0 };
      }
    }

    const host = new Host();
    const payload = JSON.parse('{"__proto__":{"isAdmin":true},"count":2}') as {
      count: number;
      __proto__: { isAdmin: boolean };
    };

    host.setState(payload);

    expect(host.state.count).toBe(2);
    expect(Object.getPrototypeOf(host.state)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(host.state, '__proto__')).toBe(true);
    expect((host.state as { __proto__?: { isAdmin?: boolean } })['__proto__']).toEqual({
      isAdmin: true,
    });
    expect(Object.prototype.hasOwnProperty.call(host.state, 'isAdmin')).toBe(false);
    expect((host.state as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  });

  test('UseCommandBus on __proto__ field injects bus as own property', () => {
    type TC = RuntimeCommand<'X', { n: number }>;
    type TQ = RuntimeQuery<'Y', { s: string }>;
    type TE = RuntimeEvent<'Z', { z: boolean }>;

    class Target {
      @UseCommandBus()
      public declare ['__proto__']: ReturnType<typeof createRuntimeBuses<TC, TQ, TE>>['commandBus'];
    }

    const buses = createRuntimeBuses<TC, TQ, TE>();
    const target = new Target();
    const dispose = wireRuntimeBuses(target, buses);

    expect(Object.getPrototypeOf(target)).toBe(Target.prototype);
    expect(Object.prototype.hasOwnProperty.call(target, '__proto__')).toBe(true);
    expect(Reflect.get(target, '__proto__')).toBe(buses.commandBus);
    expect(typeof target.constructor).toBe('function');

    dispose();
  });
});
