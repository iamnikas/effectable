/**
 * Brand used by `connect` so GraphRuntime can rebind lifecycle hooks after
 * construction completes (including subclass class-field initializers).
 *
 * Class fields use [[DefineOwnProperty]], so they overwrite data properties
 * installed in the Connected constructor. GraphRuntime invokes this brand
 * immediately after `new`, before lifecycle startup.
 *
 * @module Effectable/component/connectBrand
 */

/**
 * Instance method brand: re-capture own `onMount` / `onUnmount` and reinstall
 * Connected wiring so store subscribe / mapState / teardown still run.
 */
export const CONNECT_REBIND_LIFECYCLE: unique symbol = Symbol(
  'effectable.connect.rebindLifecycle'
);
