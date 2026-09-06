/**
 * Regression: mapStateToProps must not treat a Promise/thenable as a props Record.
 *
 * `typeof promise === 'object'`, so without an explicit thenable check the Promise was
 * installed as `__connectStateProps`. Reading mapped fields then yields `undefined`
 * while mount still succeeds — silent broken state props.
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

interface State {
  n: number;
}

type TestAction = { type: string };

describe('connect mapStateToProps thenable rejection', () => {
  it('fails mount when mapState returns a Promise (async mapper)', async () => {
    const store = createStore<State, TestAction>(
      (state) => state,
      { n: 42 },
    );

    class Gate extends Component<{ n?: number }, Record<string, never>> {
      public constructor (props: Record<string, never>) {
        super(props);
      }

      public override compose (): VirtualServiceNode | null {
        return null;
      }
    }

    const Connected = connect(
      store,
      // Cast: production typings forbid async mappers; runtime must still reject them.
      (async (s: State) => ({ n: s.n })) as (s: State) => { n: number },
    )(Gate);

    await expect(GraphRuntime.mount(h(Connected, {}))).rejects.toThrow(
      /mapStateToProps must return a plain object synchronously/i,
    );
  });

  it('fails mount when mapState returns a non-Promise thenable', async () => {
    const store = createStore<State, TestAction>(
      (state) => state,
      { n: 7 },
    );

    class Gate extends Component<{ n?: number }, Record<string, never>> {
      public constructor (props: Record<string, never>) {
        super(props);
      }

      public override compose (): VirtualServiceNode | null {
        return null;
      }
    }

    const thenable = {
      then (onFulfilled?: (value: { n: number }) => unknown) {
        return Promise.resolve({ n: 7 }).then(onFulfilled);
      },
    };

    const Connected = connect(
      store,
      (() => thenable) as (s: State) => { n: number },
    )(Gate);

    await expect(GraphRuntime.mount(h(Connected, {}))).rejects.toThrow(
      /Promise\/thenable results are not supported/i,
    );
  });
});
