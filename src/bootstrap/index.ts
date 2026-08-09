/**
 * Public entry point of the Effectable bootstrap subsystem.
 *
 * @module Effectable/bootstrap
 */

export { bootstrap } from './bootstrap';
export {
  BOOTSTRAP_RUNTIME_NODE_KIND,
  BOOTSTRAP_RUNTIME_NODE_OWNERSHIP,
} from './types';
export type {
  BootstrapHandle,
  BootstrapOptions,
  BootstrapRuntimeNodeIdentity,
  BootstrapRuntimeNodeKind,
  BootstrapRuntimeNodeOwnership,
  BootstrapRuntimePrimitives,
} from './types';
