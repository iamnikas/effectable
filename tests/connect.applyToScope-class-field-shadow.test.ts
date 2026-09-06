/**
 * Regression: class-field `applyToScope` on a connected host must not shadow
 * `Connected.prototype.applyToScope`.
 *
 * GraphRuntime calls `instance.applyToScope(...)`. An own class-field property
 * wins over the HOC prototype method, so without capture/reinstall CONNECT_STORE_CONTEXT
 * is never published and child-connected mounts fail with "Store is not available".
 *
 * Also covers sync-before-user-apply: mapState-derived props must be visible when the
 * class-field publisher reads `this.props` on first materialize.
 *
 * @module Effectable/connect/applyToScope-class-field-shadow.test
 */

import {
  Component,
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

const SECRET = createContext<string>('CLASS_FIELD_SCOPE_SECRET', 'default');

describe('connect class-field applyToScope must not shadow store publish', () => {
  it('child-connected under class-field applyToScope host still receives store', async () => {
    const store = createStore<State, TestAction>(
      (state) => state,
      { secret: 'LIVE' },
    );

    let childMounted = false;
    let childSecret: string | undefined;
    let contextSecret: string | undefined;

    class ProviderShell extends Component<{ secret?: string }, Record<string, never>> {
      // Own property — shadows Connected.prototype.applyToScope for instance lookup.
      public applyToScope = (parentScope: ContextScope): ContextScope => {
        return extendScope(parentScope, SECRET, this.props.secret ?? 'MISSING');
      };

      public override compose (): VirtualServiceNode | null {
        return h(ConnectedChild, {});
      }
    }

    class ChildShell extends Component<{ secret?: string }, Record<string, never>> {
      @UseContext(SECRET)
      public injectedSecret!: string;

      public override onMount (): void {
        childMounted = true;
        childSecret = this.props.secret;
        contextSecret = this.injectedSecret;
      }
    }

    const ConnectedChild = connect((s: State) => ({ secret: s.secret }))(ChildShell);
    const ConnectedProvider = connect(
      store,
      (s: State) => ({ secret: s.secret }),
    )(ProviderShell);

    const rt = await GraphRuntime.mount(h(ConnectedProvider, {}));

    expect(rt.isActive()).toBe(true);
    expect(childMounted).toBe(true);
    expect(childSecret).toBe('LIVE');
    // Class-field publisher still runs (custom token), and mapState synced first.
    expect(contextSecret).toBe('LIVE');

    await rt.unmount();
    store.destroy();
  });
});
