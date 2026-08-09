/**
 * Re-export connect and types for Effectable/connect.
 *
 * @module Effectable/connect
 */

export { connect } from './connect';
export type {
  MapStateToProps,
  MapDispatchToProps,
  MapDispatchToPropsFunction,
  MapDispatchToPropsDispatchOnly,
  ActionCreatorsMap,
  ConnectOptions,
  OwnPropsMode,
  ConnectableInstance,
  ConnectableConstructor,
  ConnectableHocTarget
} from './types';
