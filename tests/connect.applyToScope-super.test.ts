/**
 * Regression: Connected.applyToScope must delegate to the wrapped class's
 * applyToScope before publishing CONNECT_STORE_CONTEXT.
 *
 * Without that call, connect(ContextProvider) / connect(custom provider)
 * silently drops user context tokens — children read token defaults instead
 * of provider values (no throw, wrong DI).
 *
 * @module Effectable/connect/applyToScope-super.test
 */

import {
  Component,
  ContextProvider,
  GraphRuntime,
  UseContext,
  connect,
  createContext,
  createStore,
  extendScope,
  h,
} from 'Effectable';
import type { ContextScope, VirtualServiceNode } from 'Effectable';

interface State {
  n: number;
}

type TestAction = { type: string };

const SECRET = createContext<string>('CONNECT_APPLY_SCOPE_SECRET', 'default');

describe('connect applyToScope delegates to wrapped provider', () => {
  it('preserves custom applyToScope tokens for @UseContext children', async () => {
    const store = createStore<State, TestAction>((state) => state, { n: 1 });
    let seen: string | undefined;
    let parentApplyCalls = 0;

    class ProviderShell extends Component<
      { value: string; n?: number },
      { value: string }
    > {
      public applyToScope (parentScope: ContextScope): ContextScope {
        parentApplyCalls += 1;
        return extendScope(parentScope, SECRET, this.props.value);
      }

      public override compose (): VirtualServiceNode | null {
        return h(Consumer, {});
      }
    }

    class Consumer extends Component {
      @UseContext(SECRET)
      public secret!: string;

      public override onMount (): void {
        seen = this.secret;
      }
    }

    // Strict own-props: forward `value` so applyToScope can publish it.
    const Connected = connect(
      store,
      (_s: State, own: { value: string }) => ({ n: _s.n, value: own.value }),
    )(ProviderShell);

    const rt = await GraphRuntime.mount(h(Connected, { value: 'secret' }));
    expect(rt.isActive()).toBe(true);
    expect(parentApplyCalls).toBeGreaterThan(0);
    expect(seen).toBe('secret');
    await rt.unmount();
    store.destroy();
  });

  it('preserves ContextProvider value when the provider class is connected', async () => {
    const store = createStore<State, TestAction>((state) => state, { n: 1 });
    let seen: string | undefined;

    class Consumer extends Component {
      @UseContext(SECRET)
      public secret!: string;

      public override onMount (): void {
        seen = this.secret;
      }
    }

    type ProviderValue = [typeof SECRET, string];
    const ConnectedProvider = connect(
      store,
      (_s: State, own: { value: ProviderValue }) => ({ value: own.value }),
    )(ContextProvider);

    const rt = await GraphRuntime.mount(
      h(
        ConnectedProvider as unknown as typeof ContextProvider,
        { value: [SECRET, 'from-provider'] as ProviderValue },
        [h(Consumer, {})],
      ),
    );

    expect(rt.isActive()).toBe(true);
    expect(seen).toBe('from-provider');
    await rt.unmount();
    store.destroy();
  });

  it('regression: without super-delegation children only see the token default', async () => {
    // Documents the pre-fix failure mode for a non-connected custom provider
    // sibling pattern is covered elsewhere; here we assert the connected path
    // no longer returns the default when a real value is published.
    const store = createStore<State, TestAction>((state) => state, { n: 0 });
    let seen: string | undefined;

    class ProviderShell extends Component<{ value: string }, { value: string }> {
      public applyToScope (parentScope: ContextScope): ContextScope {
        return extendScope(parentScope, SECRET, this.props.value);
      }

      public override compose (): VirtualServiceNode | null {
        return h(Consumer, {});
      }
    }

    class Consumer extends Component {
      @UseContext(SECRET)
      public secret!: string;

      public override onMount (): void {
        seen = this.secret;
      }
    }

    const Connected = connect(
      store,
      null,
      null,
      { ownPropsModeMerge: true },
    )(ProviderShell);

    const rt = await GraphRuntime.mount(h(Connected, { value: 'merged-secret' }));
    expect(seen).toBe('merged-secret');
    expect(seen).not.toBe('default');
    await rt.unmount();
    store.destroy();
  });
});
