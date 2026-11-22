/**
 * NaN own-props must be shallow-equal under RUNTIME_PROPS_RECEIVER.
 *
 * #107 / nested mapDispatch gate uses `!==`, so stable `NaN` always looks changed:
 * parent compose passes `{ scale: NaN }` → child refreshDispatchProps → side-effect
 * dispatch → parent select → setState → child UPDATE → … → GraphRuntime fail-stop.
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';
import type { DispatchMethod } from 'Effectable';

describe('connect NaN own-props shallowEqual (mapDispatch side-effect)', () => {
  type S = { n: number };
  type A = { type: 'TICK' };

  function makeReducer () {
    return (state: S | undefined, action: A): S => {
      const current = state ?? { n: 0 };
      if (action.type === 'TICK') {
        return { n: current.n + 1 };
      }
      return current;
    };
  }

  it('stable NaN own-prop does not re-enter mapDispatch / fail-stop GraphRuntime', async () => {
    let mapDispatchCalls = 0;
    const store = createStore(makeReducer(), { n: 0 });

    class Child extends Component<object, { n?: number; scale?: number; ping?: () => void }> {
      public override compose () {
        return [];
      }
    }

    const ConnectedChild = connect(
      store,
      (s: S) => ({ n: s.n }),
      (dispatch: DispatchMethod<A>) => {
        mapDispatchCalls += 1;
        dispatch({ type: 'TICK' });
        return { ping: () => dispatch({ type: 'TICK' }) };
      },
    )(Child);

    class Parent extends Component<object, { n?: number }> {
      public override compose () {
        // Parent always allocates a new props object; scale is NaN every pass.
        return [h(ConnectedChild, { scale: Number.NaN })];
      }
    }

    const ConnectedParent = connect(store, (s: S) => ({ n: s.n }))(Parent);

    const runtime = await GraphRuntime.mount(h(ConnectedParent, {}));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 120);
    });

    expect(runtime.getState()).toBe('active');
    expect(runtime.isActive()).toBe(true);
    // applyToScope + onMount (+ at most one props-receiver if own props truly change).
    // Without Object.is, NaN !== NaN loops into dozens of mapDispatch calls / failed.
    expect(mapDispatchCalls).toBeLessThan(10);

    store.dispatch({ type: 'TICK' });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 120);
    });

    expect(runtime.getState()).toBe('active');
    expect(mapDispatchCalls).toBeLessThan(10);

    await runtime.unmount();
  });

  it('finite own-prop change still rebinds mapDispatch', async () => {
    let lastScale: number | undefined;
    const store = createStore(makeReducer(), { n: 0 });

    type ChildOwn = { scale?: number };
    type ChildProps = {
      n?: number;
      scale?: number;
      readScale?: () => number | undefined;
      ping?: () => void;
    };

    class Child extends Component<object, ChildProps> {
      public override compose () {
        return [];
      }
    }

    const ConnectedChild = connect(
      store,
      (s: S) => ({ n: s.n }),
      (dispatch: DispatchMethod<A>, props: ChildOwn) => {
        lastScale = props.scale;
        return {
          readScale: () => lastScale,
          ping: () => dispatch({ type: 'TICK' }),
        };
      },
    )(Child);

    class Parent extends Component<{ scale: number }, { n?: number }> {
      constructor (props: { n?: number }) {
        super(props);
        this.state = { scale: Number.NaN };
      }

      public override compose () {
        return [h(ConnectedChild, { scale: this.state.scale })];
      }
    }

    const ConnectedParent = connect(store, (s: S) => ({ n: s.n }))(Parent);
    const runtime = await GraphRuntime.mount(h(ConnectedParent, {}));
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(Number.isNaN(lastScale)).toBe(true);

    const parent = runtime.getRootInstance() as Parent;
    parent.setState({ scale: 2 });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(lastScale).toBe(2);
    expect(runtime.getState()).toBe('active');
    await runtime.unmount();
  });
});
