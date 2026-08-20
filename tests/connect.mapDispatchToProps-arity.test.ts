/**
 * Tests for mapDispatchToProps always receives (dispatch, props)
 * regardless of function.length (default params, rest params, bound functions).
 *
 * @module Effectable/connect.mapDispatchToProps-arity.test
 */

import { Component, connect, createStore } from 'Effectable';
import type { DispatchMethod } from 'Effectable';

interface TestState {
  lastId: string;
  version: number;
}

type TestAction =
  | { type: 'SET_ID'; payload: string }
  | { type: 'BUMP_VERSION' };

interface TestProps {
  id: string;
  emitOwnId?: () => void;
  version?: number;
}

/**
 * Reducer for the test store.
 */
function reducer (state: TestState, action: TestAction): TestState {
  switch (action.type) {
    case 'SET_ID':
      return { ...state, lastId: action.payload };
    case 'BUMP_VERSION':
      return { ...state, version: state.version + 1 };
    default:
      return state;
  }
}

describe('connect mapDispatchToProps arity (issue #23)', () => {
  test('second parameter without default — props are passed', () => {
    const store = createStore<TestState, TestAction>(reducer, {
      lastId: '',
      version: 0,
    });

    function mapDispatchWithoutDefault (
      dispatch: DispatchMethod<TestAction>,
      props: TestProps
    ): Pick<TestProps, 'emitOwnId'> {
      return {
        emitOwnId: (): void => {
          dispatch({ type: 'SET_ID', payload: props.id });
        },
      };
    }

    expect(mapDispatchWithoutDefault.length).toBe(2);

    class WithoutDefaultComponent extends Component<object, TestProps> {
      constructor (props: TestProps) {
        super(props);
        this.state = {};
      }
    }

    const Connected = connect<TestState, TestProps, unknown, TestAction>(
      store,
      undefined,
      mapDispatchWithoutDefault,
      { ownPropsModeMerge: true }
    )(WithoutDefaultComponent);

    const instance = new Connected({ id: 'no-default-param' }) as WithoutDefaultComponent;
    instance.onMount?.();
    expect(typeof instance.props.emitOwnId).toBe('function');

    instance.props.emitOwnId?.();
    expect(store.getState().lastId).toBe('no-default-param');

    instance.onUnmount?.();
    store.destroy();
  });

  test('second parameter with default — props are passed (not default value)', () => {
    const store = createStore<TestState, TestAction>(reducer, {
      lastId: '',
      version: 0,
    });

    function mapDispatchWithDefault (
      dispatch: DispatchMethod<TestAction>,
      props: TestProps = { id: 'default-fallback' }
    ): Pick<TestProps, 'emitOwnId'> {
      return {
        emitOwnId: (): void => {
          dispatch({ type: 'SET_ID', payload: props.id });
        },
      };
    }

    expect(mapDispatchWithDefault.length).toBe(1);

    class WithDefaultComponent extends Component<object, TestProps> {
      constructor (props: TestProps) {
        super(props);
        this.state = {};
      }
    }

    const Connected = connect<TestState, TestProps, unknown, TestAction>(
      store,
      undefined,
      mapDispatchWithDefault,
      { ownPropsModeMerge: true }
    )(WithDefaultComponent);

    const instance = new Connected({ id: 'actual-id' }) as WithDefaultComponent;
    instance.onMount?.();
    expect(typeof instance.props.emitOwnId).toBe('function');

    instance.props.emitOwnId?.();
    expect(store.getState().lastId).toBe('actual-id');

    instance.onUnmount?.();
    store.destroy();
  });

  test('rest parameters — props are passed as first positional arg', () => {
    const store = createStore<TestState, TestAction>(reducer, {
      lastId: '',
      version: 0,
    });

    function mapDispatchWithRest (
      dispatch: DispatchMethod<TestAction>,
      ...args: unknown[]
    ): Pick<TestProps, 'emitOwnId'> {
      const props = args[0] as TestProps;
      return {
        emitOwnId: (): void => {
          dispatch({ type: 'SET_ID', payload: props.id });
        },
      };
    }

    expect(mapDispatchWithRest.length).toBe(1);

    class RestParamsComponent extends Component<object, TestProps> {
      constructor (props: TestProps) {
        super(props);
        this.state = {};
      }
    }

    const Connected = connect<TestState, TestProps, unknown, TestAction>(
      store,
      undefined,
      mapDispatchWithRest,
      { ownPropsModeMerge: true }
    )(RestParamsComponent);

    const instance = new Connected({ id: 'rest-param-id' }) as RestParamsComponent;
    instance.onMount?.();
    expect(typeof instance.props.emitOwnId).toBe('function');

    instance.props.emitOwnId?.();
    expect(store.getState().lastId).toBe('rest-param-id');

    instance.onUnmount?.();
    store.destroy();
  });

  test('bound mapper — props are passed regardless of bind', () => {
    const store = createStore<TestState, TestAction>(reducer, {
      lastId: '',
      version: 0,
    });

    function mapDispatchUnbound (
      this: unknown,
      dispatch: DispatchMethod<TestAction>,
      props: TestProps
    ): Pick<TestProps, 'emitOwnId'> {
      return {
        emitOwnId: (): void => {
          dispatch({ type: 'SET_ID', payload: props.id });
        },
      };
    }

    // Bind with context only — length remains 2, but demonstrates bind() usage
    const mapDispatchBound = mapDispatchUnbound.bind({ context: 'test' });

    expect(mapDispatchUnbound.length).toBe(2);
    expect(mapDispatchBound.length).toBe(2);

    class BoundMapperComponent extends Component<object, TestProps> {
      constructor (props: TestProps) {
        super(props);
        this.state = {};
      }
    }

    const Connected = connect<TestState, TestProps, unknown, TestAction>(
      store,
      undefined,
      mapDispatchBound,
      { ownPropsModeMerge: true }
    )(BoundMapperComponent);

    const instance = new Connected({ id: 'bound-id' }) as BoundMapperComponent;
    instance.onMount?.();
    expect(typeof instance.props.emitOwnId).toBe('function');

    instance.props.emitOwnId?.();
    expect(store.getState().lastId).toBe('bound-id');

    instance.onUnmount?.();
    store.destroy();
  });

  test('mapper that uses only dispatch — second arg ignored', () => {
    const store = createStore<TestState, TestAction>(reducer, {
      lastId: '',
      version: 0,
    });

    function mapDispatchOnly (
      dispatch: DispatchMethod<TestAction>
    ): { bump: () => void } {
      return {
        bump: (): void => {
          dispatch({ type: 'BUMP_VERSION' });
        },
      };
    }

    expect(mapDispatchOnly.length).toBe(1);

    interface DispatchOnlyProps extends TestProps {
      bump?: () => void;
    }

    class DispatchOnlyComponent extends Component<object, DispatchOnlyProps> {
      constructor (props: DispatchOnlyProps) {
        super(props);
        this.state = {};
      }
    }

    const Connected = connect<TestState, DispatchOnlyProps, unknown, TestAction>(
      store,
      undefined,
      mapDispatchOnly,
      { ownPropsModeMerge: true }
    )(DispatchOnlyComponent);

    const instance = new Connected({ id: 'dispatch-only-id' }) as DispatchOnlyComponent;
    instance.onMount?.();
    expect(typeof instance.props.bump).toBe('function');

    instance.props.bump?.();
    expect(store.getState().version).toBe(1);

    instance.onUnmount?.();
    store.destroy();
  });

  test('mapper with default param, reconcile updates props — uses new props', async () => {
    const { GraphRuntime, h } = await import('Effectable');

    const store = createStore<TestState, TestAction>(reducer, {
      lastId: '',
      version: 0,
    });

    function mapDispatchWithDefault (
      dispatch: DispatchMethod<TestAction>,
      props: TestProps = { id: 'fallback' }
    ): Pick<TestProps, 'emitOwnId'> {
      return {
        emitOwnId: (): void => {
          dispatch({ type: 'SET_ID', payload: props.id });
        },
      };
    }

    expect(mapDispatchWithDefault.length).toBe(1);

    class ReconcileDefaultChild extends Component<object, TestProps> {
      constructor (props: TestProps) {
        super(props);
        this.state = {};
      }
    }

    const childRef: { current: ReconcileDefaultChild | null } = { current: null };

    const ConnectedChild = connect<TestState, TestProps, unknown, TestAction>(
      undefined,
      mapDispatchWithDefault,
      { ownPropsModeMerge: true }
    )(ReconcileDefaultChild);

    interface RootProps {
      childId: string;
    }

    class RootHost extends Component<object, RootProps> {
      public override compose (): ReturnType<typeof h>[] {
        return [
          h(ConnectedChild, { id: this.props.childId }, childRef),
        ];
      }
    }

    const ConnectedRoot = connect(store, undefined, undefined, { ownPropsModeMerge: true })(RootHost);
    const runtime = await GraphRuntime.mount(h(ConnectedRoot, { childId: 'before' }));

    if (childRef.current === null) {
      throw new Error('Child ref was not attached');
    }

    childRef.current.props.emitOwnId?.();
    expect(store.getState().lastId).toBe('before');

    await runtime.reconcile(h(ConnectedRoot, { childId: 'after' }));

    if (childRef.current === null) {
      throw new Error('Child ref was detached after reconcile');
    }

    childRef.current.props.emitOwnId?.();
    expect(store.getState().lastId).toBe('after');

    await runtime.unmount();
    store.destroy();
  });
});
