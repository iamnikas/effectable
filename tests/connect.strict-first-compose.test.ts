/**
 * Regression: strict `connect` must not leak parent own-props into the FIRST
 * `compose()` (GraphRuntime runs compose before onMount).
 *
 * Before the fix, Connected kept constructor props until onMount rebuilt them.
 * A gate that branched on a sensitive own-prop (e.g. adminToken) would PLACE and
 * onMount the wrong child for one generation; post-mount kick-off only corrected
 * the tree afterward.
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';

describe('connect strict first-compose props', () => {
  type S = { n: number };
  type A = { type: 'INC' };

  function makeStore (): ReturnType<typeof createStore<S, A>> {
    return createStore<S, A>(
      (state, action) => (action.type === 'INC' ? { n: state.n + 1 } : state),
      { n: 0 },
    );
  }

  it('first compose does not see stripped own-props; wrong branch never mounts', async () => {
    const store = makeStore();
    const log: string[] = [];

    class AdminChild extends Component<object, object> {
      public override onMount (): void {
        log.push('Admin.onMount');
      }

      public override onUnmount (): void {
        log.push('Admin.onUnmount');
      }
    }

    class UserChild extends Component<object, object> {
      public override onMount (): void {
        log.push('User.onMount');
      }

      public override onUnmount (): void {
        log.push('User.onUnmount');
      }
    }

    class Gate extends Component<object, { adminToken?: string; n?: number }> {
      public override compose () {
        log.push(
          `Gate.compose:token=${String(this.props.adminToken)}:n=${String(this.props.n)}`,
        );
        if (this.props.adminToken !== undefined) {
          return [h(AdminChild, {})];
        }
        return [h(UserChild, {})];
      }

      public override onMount (): void {
        log.push(
          `Gate.onMount:token=${String(this.props.adminToken)}:n=${String(this.props.n)}`,
        );
      }
    }

    const ConnectedGate = connect(store, (state: S) => ({ n: state.n }))(Gate);
    const runtime = await GraphRuntime.mount(
      h(ConnectedGate, { adminToken: 'SECRET' }),
    );

    expect(log).toEqual([
      'Gate.compose:token=undefined:n=0',
      'User.onMount',
      'Gate.onMount:token=undefined:n=0',
    ]);

    await runtime.unmount();
  });

  it('provider-only strict connect strips own-props before first compose', async () => {
    const store = makeStore();
    const log: string[] = [];

    class Host extends Component<object, { secret?: string }> {
      public override compose () {
        log.push(`Host.compose:secret=${String(this.props.secret)}`);
        return [];
      }
    }

    const ConnectedHost = connect(store)(Host);
    const runtime = await GraphRuntime.mount(
      h(ConnectedHost, { secret: 'LEAK' }),
    );

    expect(log).toEqual(['Host.compose:secret=undefined']);
    await runtime.unmount();
  });
});
