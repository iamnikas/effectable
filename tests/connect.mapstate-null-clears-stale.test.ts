/**
 * Live mapState transition object → null/array/primitive must clear
 * `__connectStateProps`. Remount already clears (#66); store emissions did not —
 * logout-style mappers left revoked fields on props and delivered onUpdate with them.
 */
import { Component, connect, createStore } from 'Effectable';

type S = { user: string | null };
type A = { type: 'LOGIN'; user: string } | { type: 'LOGOUT' };

function makeStore (initial: S = { user: 'Ada' }) {
  return createStore<S, A>((state = initial, action) => {
    if (action.type === 'LOGIN') {
      return { user: action.user };
    }
    if (action.type === 'LOGOUT') {
      return { user: null };
    }
    return state;
  }, initial);
}

describe('connect mapState null clears stale state props', () => {
  test('object → null emission drops previous mapped fields', () => {
    const store = makeStore();
    const updates: Array<{ name?: string; token?: string }> = [];

    class Host extends Component<
      { name?: string; token?: string },
      Record<string, never>
    > {
      public override onUpdate (): void {
        updates.push({
          name: this.props.name,
          token: this.props.token,
        });
      }
    }

    const Connected = connect(store, (s: S) =>
      (s.user
        ? { name: s.user, token: `secret-${s.user}` }
        : null) as { name: string; token: string } | null
    )(Host);

    const inst = new Connected({});
    void inst.onMount!();
    expect(inst.props.name).toBe('Ada');
    expect(inst.props.token).toBe('secret-Ada');

    store.dispatch({ type: 'LOGOUT' });

    expect(inst.props.name).toBeUndefined();
    expect(inst.props.token).toBeUndefined();
    expect(updates.length).toBeGreaterThanOrEqual(1);
    const last = updates[updates.length - 1]!;
    expect(last.name).toBeUndefined();
    expect(last.token).toBeUndefined();
  });

  test('object → array emission also clears previous mapped fields', () => {
    const store = makeStore();

    class Host extends Component<{ name?: string }, Record<string, never>> {}

    const Connected = connect(store, (s: S) =>
      (s.user ? { name: s.user } : (['x'] as unknown)) as { name: string }
    )(Host);

    const inst = new Connected({});
    void inst.onMount!();
    expect(inst.props.name).toBe('Ada');

    store.dispatch({ type: 'LOGOUT' });
    expect(inst.props.name).toBeUndefined();
  });

  test('always-null mapState still mounts without inventing props', () => {
    const store = makeStore({ user: null });

    class Host extends Component<{ name?: string }, Record<string, never>> {}

    const Connected = connect(store, () => null as unknown as { name: string })(Host);

    const inst = new Connected({});
    void inst.onMount!();
    expect(inst.props.name).toBeUndefined();
  });
});
