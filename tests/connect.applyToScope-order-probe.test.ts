/**
 * Regression: Connected.applyToScope must sync mapped props BEFORE calling the
 * wrapped class's applyToScope.
 *
 * #111 restored super.applyToScope but ran it before syncConnectPropsBeforeCompose.
 * Providers that publish from mapState-derived fields (not constructor own-props)
 * then wrote `undefined` into the child scope on first materialize — silent wrong DI.
 *
 * @module Effectable/connect/applyToScope-order-probe.test
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
  secret: string;
}

type TestAction = { type: string };

const TOKEN = createContext<string>('CONNECT_APPLY_SCOPE_ORDER', 'default');

describe('connect applyToScope syncs mapped props before wrapped applyToScope', () => {
  it('publishes mapState-derived props from applyToScope on first materialize', async () => {
    const store = createStore<State, TestAction>((state) => state, { secret: 'from-store' });
    let seen: string | undefined;

    class ProviderShell extends Component {
      public applyToScope (parentScope: ContextScope): ContextScope {
        // Publish from a mapped state prop — absent on constructor own-props.
        return extendScope(
          parentScope,
          TOKEN,
          (this.props as { secret?: string }).secret as string,
        );
      }

      public override compose (): VirtualServiceNode | null {
        return h(Consumer, {});
      }
    }

    class Consumer extends Component {
      @UseContext(TOKEN)
      public secret!: string;

      public override onMount (): void {
        seen = this.secret;
      }
    }

    const Connected = connect(
      store,
      (state: State) => ({ secret: state.secret }),
    )(ProviderShell);

    const rt = await GraphRuntime.mount(h(Connected, {}));
    expect(rt.isActive()).toBe(true);
    expect(seen).toBe('from-store');
    expect(seen).not.toBe('default');
    expect(seen).not.toBe(undefined);
    await rt.unmount();
    store.destroy();
  });

  it('still preserves ContextProvider value when value is forwarded via mapState', async () => {
    const store = createStore<State, TestAction>((state) => state, { secret: 'x' });
    let seen: string | undefined;

    class Consumer extends Component {
      @UseContext(TOKEN)
      public secret!: string;

      public override onMount (): void {
        seen = this.secret;
      }
    }

    type ProviderValue = [typeof TOKEN, string];
    const ConnectedProvider = connect(
      store,
      (_s: State, own: { value: ProviderValue }) => ({ value: own.value }),
    )(ContextProvider);

    const rt = await GraphRuntime.mount(
      h(
        ConnectedProvider as unknown as typeof ContextProvider,
        { value: [TOKEN, 'from-provider'] as ProviderValue },
        [h(Consumer, {})],
      ),
    );

    expect(rt.isActive()).toBe(true);
    expect(seen).toBe('from-provider');
    await rt.unmount();
    store.destroy();
  });
});
