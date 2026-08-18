/**
 * Unit tests for context scope and injections without GraphRuntime.
 *
 * @module Effectable/component/context.entity.test
 */

import {
  Component,
  ContextProvider,
  createContext,
  EMPTY_CONTEXT_SCOPE,
  extendScope,
  getContextFields,
  injectContextFields,
  readFromScope,
  UseContext,
} from 'Effectable';
import { HAS_CONTEXT_FIELDS_KEY, IS_CONTEXT_PROVIDER } from 'Effectable/component/context';

const TOKEN_A = createContext<string>('TOKEN_A');
const TOKEN_B = createContext<number>('TOKEN_B', 99);

describe('createContext / extendScope / readFromScope', () => {
  it('extendScope does not mutate the parent scope', () => {
    const parent = extendScope(EMPTY_CONTEXT_SCOPE, TOKEN_A, 'hello');
    const child = extendScope(parent, TOKEN_B, 42);

    expect(parent.has(TOKEN_B.key)).toBe(false);
    expect(readFromScope(child, TOKEN_A)).toBe('hello');
    expect(readFromScope(child, TOKEN_B)).toBe(42);
  });

  it('readFromScope returns defaultValue if token is not in scope', () => {
    const scope = EMPTY_CONTEXT_SCOPE;
    expect(readFromScope(scope, TOKEN_B)).toBe(99);
  });

  it('readFromScope throws if token is missing and there is no defaultValue', () => {
    const scope = EMPTY_CONTEXT_SCOPE;

    expect(() => readFromScope(scope, TOKEN_A)).toThrow(
      /\[Effectable\] Context token "TOKEN_A" is not provided/,
    );
  });

  it('extendScope with the same token overwrites the value', () => {
    const once = extendScope(EMPTY_CONTEXT_SCOPE, TOKEN_A, 'first');
    const twice = extendScope(once, TOKEN_A, 'second');

    expect(readFromScope(twice, TOKEN_A)).toBe('second');
  });

  it('CTX-04: two createContext with the same displayName get different keys', () => {
    const first = createContext<string>('SHARED_NAME');
    const second = createContext<string>('SHARED_NAME');

    expect(first.displayName).toBe(second.displayName);
    expect(first.key).not.toBe(second.key);
  });
});

describe('J12b — ContextProvider.applyToScope (single pair vs array)', () => {
  it('a single pair and an array of one pair yield the same scope', () => {
    const single = new ContextProvider({ value: [TOKEN_A, 'solo'] });
    const fromSingle = single.applyToScope(EMPTY_CONTEXT_SCOPE);

    const arrayOne = new ContextProvider({ value: [[TOKEN_A, 'solo']] });
    const fromArray = arrayOne.applyToScope(EMPTY_CONTEXT_SCOPE);

    expect(readFromScope(fromSingle, TOKEN_A)).toBe('solo');
    expect(readFromScope(fromArray, TOKEN_A)).toBe('solo');
    expect(readFromScope(fromSingle, TOKEN_A)).toBe(readFromScope(fromArray, TOKEN_A));
  });
});

describe('ContextProvider.applyToScope', () => {
  it('applies a single [token, value] pair', () => {
    const provider = new ContextProvider({ value: [TOKEN_A, 'x'] });
    const next = provider.applyToScope(EMPTY_CONTEXT_SCOPE);

    expect(readFromScope(next, TOKEN_A)).toBe('x');
  });

  it('applies an array of pairs sequentially', () => {
    const provider = new ContextProvider({
      value: [
        [TOKEN_A, 'chain'],
        [TOKEN_B, 7],
      ],
    });
    const next = provider.applyToScope(EMPTY_CONTEXT_SCOPE);

    expect(readFromScope(next, TOKEN_A)).toBe('chain');
    expect(readFromScope(next, TOKEN_B)).toBe(7);
  });

  it('with an array of pairs, on token collision the last pair wins', () => {
    const provider = new ContextProvider({
      value: [
        [TOKEN_A, 'first'],
        [TOKEN_A, 'second'],
      ],
    });
    const next = provider.applyToScope(EMPTY_CONTEXT_SCOPE);

    expect(readFromScope(next, TOKEN_A)).toBe('second');
  });

  it('applyToScope overrides the token value from the parent scope', () => {
    const parentScope = extendScope(EMPTY_CONTEXT_SCOPE, TOKEN_A, 'from-parent');
    const provider = new ContextProvider({ value: [TOKEN_A, 'from-provider'] });
    const next = provider.applyToScope(parentScope);

    expect(readFromScope(next, TOKEN_A)).toBe('from-provider');
  });
});

describe('UseContext / getContextFields / injectContextFields', () => {
  class Consumer extends Component<Record<string, unknown>, Record<string, unknown>> {
    @UseContext(TOKEN_A)
    public injected!: string;

    constructor () {
      super({});
    }
  }

  it('getContextFields returns metadata for @UseContext', () => {
    const fields = getContextFields(Consumer as unknown as Parameters<typeof getContextFields>[0]);
    expect(fields).toHaveLength(1);
    expect(fields[0]?.token.displayName).toBe('TOKEN_A');
    expect(fields[0]?.propertyKey).toBe('injected');
  });

  it('injectContextFields fills fields from scope', () => {
    const scope = extendScope(EMPTY_CONTEXT_SCOPE, TOKEN_A, 'from-scope');
    const instance = new Consumer();
    injectContextFields(instance, scope);

    expect(instance.injected).toBe('from-scope');
  });

  it('injectContextFields throws if the value is unavailable', () => {
    const TOKEN_NO_DEFAULT = createContext<string>('TOKEN_NO_DEFAULT');
    class Bad extends Component<Record<string, unknown>, Record<string, unknown>> {
      @UseContext(TOKEN_NO_DEFAULT)
      public v!: string;

      constructor () {
        super({});
      }
    }

    const instance = new Bad();
    expect(() => injectContextFields(instance, EMPTY_CONTEXT_SCOPE)).toThrow(
      /TOKEN_NO_DEFAULT/,
    );
  });

  it('getContextFields for a class without @UseContext returns an empty array', () => {
    class Plain extends Component<Record<string, unknown>, Record<string, unknown>> {
      constructor () {
        super({});
      }
    }

    expect(getContextFields(Plain as unknown as Parameters<typeof getContextFields>[0])).toEqual([]);
  });

  it('CTX-11: injectContextFields for a class without @UseContext — fast-path with no injection', () => {
    class Plain extends Component<Record<string, unknown>, Record<string, unknown>> {
      public marker = 'untouched';

      constructor () {
        super({});
      }
    }

    const ctor = Plain as unknown as { [key: symbol]: unknown };
    expect(ctor[HAS_CONTEXT_FIELDS_KEY]).toBeUndefined();

    const scope = extendScope(EMPTY_CONTEXT_SCOPE, TOKEN_A, 'would-inject');
    const instance = new Plain();
    injectContextFields(instance, scope);

    expect(instance.marker).toBe('untouched');
    expect(getContextFields(Plain as unknown as Parameters<typeof getContextFields>[0])).toEqual([]);
  });

  it('CTX-10: injectContextFields accepts explicit undefined from scope (scope.has)', () => {
    const TOKEN_UNDEF = createContext<string | undefined>('TOKEN_UNDEF');
    class UndefConsumer extends Component<Record<string, unknown>, Record<string, unknown>> {
      @UseContext(TOKEN_UNDEF)
      public injected: string | undefined = 'sentinel';

      constructor () {
        super({});
      }
    }

    const scope = extendScope(EMPTY_CONTEXT_SCOPE, TOKEN_UNDEF, undefined);
    const instance = new UndefConsumer();
    injectContextFields(instance, scope);

    expect(Object.hasOwn(instance, 'injected') || 'injected' in instance).toBe(true);
    expect(instance.injected).toBeUndefined();
  });
});

describe('ContextProvider entity contract', () => {
  it('CTX-13: IS_CONTEXT_PROVIDER on ContextProvider prototype is true', () => {
    const proto = ContextProvider.prototype as unknown as Record<symbol, unknown>;

    expect(proto[IS_CONTEXT_PROVIDER]).toBe(true);

    const provider = new ContextProvider({ value: [TOKEN_B, 1] });
    const instance = provider as unknown as Record<symbol, unknown>;
    expect(instance[IS_CONTEXT_PROVIDER]).toBe(true);
  });
});
