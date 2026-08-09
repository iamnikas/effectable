/**
 * Re-exports types, the base Component class, and declarative composition utilities for Effectable/component.
 *
 * @module Effectable/component
 */

export type {
  Lifecycle,
  Disposable,
  RuntimePropsReceiver,
  RefObject,
  VirtualServiceNode,
  NodeLifecycleStatus,
  FiberEffectTag,
  FiberInspectNode,
  Fiber,
  ComponentConstructor,
} from './types';
export { RUNTIME_PROPS_RECEIVER, FIBER_EFFECT_TAG } from './types';
export { Component } from './Component';
export type { SetStateUpdate } from './Component';
export { h } from './h';
export { LifecycleEngine } from './lifecycle';
export type { LifecycleTransitionResult } from './lifecycle';
export { UseRef, UseImperativeHandle, getRefFields, getImperativeHandleMethods } from './refs';
export type { RefFieldMeta, ImperativeHandleMeta } from './refs';
export { REF_FIELDS_META_KEY, IMPERATIVE_HANDLE_META_KEY } from './refs';
export {
  createContext,
  extendScope,
  readFromScope,
  ContextProvider,
  UseContext,
  getContextFields,
  injectContextFields,
  EMPTY_CONTEXT_SCOPE,
  CONTEXT_FIELDS_META_KEY,
} from './context';
export type {
  ContextToken,
  ContextScope,
  ContextProviderProps,
  ContextFieldMeta,
} from './context';
export { GraphRuntime, makeFiberEffectTag } from './GraphRuntime';
