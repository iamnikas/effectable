/**
 * Re-export connect and types for Effectable/connect.
 *
 * @module Effectable/connect
 */

export { connect, CONNECT_HOC_BRAND } from './connect';
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
