/**
 * Types for the connect HOC: mapping store state into instance props/state, options.
 *
 * @module Effectable/connect/types
 */

import type { Action, DispatchMethod } from '../store/types';
import type { Lifecycle } from '../component/types';

/**
 * Function that maps store state into state/props passed to the class instance.
 *
 * @template S - Store state type
 * @template P - Props type passed when creating the instance
 * @template R - Result type (store slice for merge into props)
 */
export type MapStateToProps<S, P = unknown, R = unknown> = (
  state: S,
  props: P
) => R;

/**
 * mapDispatchToProps function: (dispatch, props) => object of callbacks merged into props.
 *
 * @template _S - not used directly in the signature; kept for consistency with mapStateToProps
 * @template P - instance props type
 * @template A - store action union type
 */
export type MapDispatchToPropsFunction<_S, P, A extends Action = Action> = (
  dispatch: DispatchMethod<A>,
  props: P
) => unknown;

/**
 * Short mapDispatch form: only `(dispatch) => object of callbacks`.
 * Inside `connect` it is called as `fn(dispatch)` without passing `props` from outside
 * (no need to write `(d) => mapXxx(d)` when passing `mapXxx` as the third argument).
 */
export type MapDispatchToPropsDispatchOnly<A extends Action = Action> = (dispatch: DispatchMethod<A>) => unknown;

/**
 * Action creators object: keys are prop names, values are functions returning an action.
 * `connect` binds them via `dispatch(actionCreator(...args))`.
 */
export type ActionCreatorsMap<A extends Action = Action> = Record<
  string,
  (...args: unknown[]) => A
>;

/**
 * Third argument of `connect`: full function `(dispatch, props) => …`, short `(dispatch) => …`,
 * or an object of action creators.
 */
export type MapDispatchToProps<S, P, A extends Action = Action> =
  | MapDispatchToPropsFunction<S, P, A>
  | MapDispatchToPropsDispatchOnly<A>
  | ActionCreatorsMap<A>;

/**
 * Mode for building the wrapped component's public `this.props` from props and mapper results.
 *
 * - `'merge'` (legacy/transitional): final props are `props -> dispatchProps -> stateProps`,
 *   i.e. parent props automatically appear in `this.props`.
 * - `'strict'`: parent props are used only as mapper inputs; public `this.props`
 *   receives only what `mapStateToProps`/`mapDispatchToProps` explicitly returned.
 */
export type OwnPropsMode = 'merge' | 'strict';

/**
 * Options for connect.
 */
export interface ConnectOptions {
  /**
   * Enables the legacy `'merge'` props filtering mode (see {@link OwnPropsMode}).
   *
   * - `false` or unset (default): `'strict'` mode — parent props do not leak
   *   into public `this.props`; only mapper results appear there.
   * - `true`: `'merge'` mode — parent props automatically appear in `this.props`.
   *
   * Strict is the target `Effectable` contract, so most components do not need this option.
   * Set the flag to `true` only where legacy prop forwarding is intentionally required.
   */
  ownPropsModeMerge?: boolean;
}

/**
 * Shape of a class instance suitable for connect: compatible with {@link Lifecycle}, has
 * mutable `props` and `state`, and a `setState` method.
 *
 * The class must extend {@link Component} (directly or via an intermediate class).
 */
export interface ConnectableInstance<P = unknown, R = unknown> extends Lifecycle {
  props: P;
  state: R;
  setState: (update: Partial<R> | ((prevState: R, props: P) => Partial<R>)) => void;
}

/**
 * Constructor of a class suitable for wrapping with connect.
 *
 * @template P - Instance props type
 * @template R - Instance state type
 * @template TInstance - Instance shape (defaults to ConnectableInstance<P, R>)
 */
export type ConnectableConstructor<
  P = unknown,
  R = unknown,
  TInstance extends ConnectableInstance<P, R> = ConnectableInstance<P, R>,
> = new (props: P) => TInstance;

/**
 * Constructor allowed as an argument to the {@link connect} HOC.
 * The `props` parameter is widened to `any`; otherwise under `strictFunctionTypes` a class with a narrow
 * `new (props: ConcreteProps)` is incompatible with a generic `new (props: unknown)`.
 */
export type ConnectableHocTarget = new (props: any) => ConnectableInstance<any, any>;
