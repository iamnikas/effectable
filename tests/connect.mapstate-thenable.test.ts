/**
 * mapState returning a thenable must fail loudly — not install Promise as props.
 *
 * Before: async mapState / thenable return is typeof 'object', so getMappedPropsRecord
 * treated it as a props Record. Object.keys(Promise) is empty → mapped fields undefined
 * while GraphRuntime stays active (silent data loss / authz-shaped holes).
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';

describe('connect mapState thenable rejection', () => {
  type S = { n: number };
  type A = { type: 'TICK' };

  function makeStore () {
    return createStore(
      (state: S | undefined, action: A): S => {
        const current = state ?? { n: 0 };
        if (action.type === 'TICK') {
          return { n: current.n + 1 };
        }
        return current;
      },
      { n: 7 },
    );
  }

  it('async mapState rejects mount instead of leaving mapped props undefined', async () => {
    const store = makeStore();

    class Host extends Component<object, { n?: number }> {
      public override compose () {
        return [];
      }
    }

    const Connected = connect(
      store,
      async (s: S) => ({ n: s.n }),
    )(Host);

    await expect(GraphRuntime.mount(h(Connected, {}))).rejects.toThrow(
      /thenable|Promise/,
    );
  });

  it('sync mapState plain object still maps props', async () => {
    const store = makeStore();

    class Host extends Component<object, { n?: number }> {
      public override compose () {
        return [];
      }
    }

    const Connected = connect(
      store,
      (s: S) => ({ n: s.n }),
    )(Host);

    const runtime = await GraphRuntime.mount(h(Connected, {}));
    expect(runtime.getState()).toBe('active');
    expect((runtime.getRootInstance() as Host).props.n).toBe(7);
    await runtime.unmount();
  });
});
