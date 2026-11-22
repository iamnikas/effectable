/**
 * Regression: `@UseContext` field named `__proto__` must not invoke the
 * Object.prototype `__proto__` setter during {@link injectContextFields}.
 *
 * Ordinary `target[key] = value` replaces the instance [[Prototype]] with the
 * injected value and drops Component methods — same class as store/connect #109
 * and mutableState / BusDecorators #135, which did not cover context injection.
 */
import {
  Component,
  createContext,
  EMPTY_CONTEXT_SCOPE,
  extendScope,
  injectContextFields,
  UseContext,
} from 'Effectable';

describe('context injectContextFields __proto__ key assignment safety', () => {
  it('UseContext on __proto__ field injects value as own property', () => {
    const TOKEN = createContext<{ tag: string }>('PROTO_CTX');
    const injected = { tag: 'ctx-value' };

    class Host extends Component<Record<string, never>, Record<string, never>> {
      @UseContext(TOKEN)
      public declare ['__proto__']: { tag: string };

      constructor () {
        super({});
      }

      public marker (): string {
        return 'host-method';
      }
    }

    const host = new Host();
    const scope = extendScope(EMPTY_CONTEXT_SCOPE, TOKEN, injected);
    const changed = injectContextFields(host, scope);

    expect(changed).toBe(true);
    expect(Object.getPrototypeOf(host)).toBe(Host.prototype);
    expect(Object.prototype.hasOwnProperty.call(host, '__proto__')).toBe(true);
    expect((host as unknown as Record<string, unknown>)['__proto__']).toBe(injected);
    expect(host.marker()).toBe('host-method');
    expect(Object.prototype.hasOwnProperty.call(host, 'tag')).toBe(false);
    expect((host as { tag?: string }).tag).toBeUndefined();
  });
});
