/**
 * HOC connect: connects a component class to the store via mapStateToProps and/or mapDispatchToProps,
 * implemented as a class-based wrapper over the original class.
 *
 * Call: `connect(store, mapState?, mapDispatch?)(Ctor)`.
 * Third argument: full function `(dispatch, props) => …`, short `(dispatch) => …`,
 * or an object of action creators `{ key: (...args) => action }` (see `resolveMapDispatchProps`).
 *
 * Correctness contracts (public behavior, no signature change):
 * - Same-instance remount resets mount flags / generation so store wiring and post-mount kick-off
 *   run again; stale async `onMount` from a previous generation is ignored.
 * - Remount clears stale mapped state props and re-resolves the context store when needed.
 * - Class-field `onMount` / `onUnmount` (own instance properties) still go through connect wiring
 *   and do not shadow store subscribe / unsubscribe.
 * - Subclass-of-Connected prototype `override onMount` / `onUnmount` still run after wiring
 *   (own Connected hooks shadow Ext.prototype for GraphRuntime entry; connect re-resolves them),
 *   including when the wrapped base used a class-field lifecycle hook (must not win over Ext).
 *   Own-entry `this.onMount()` remount works during user hooks; subclass `super.onMount()` is a
 *   sync no-op while wiring is active (avoids double-subscribe without blocking remount).
 * - Subclass `super.onMount()` / `super.onUnmount()` after `await` must not re-enter wiring
 *   (sync reentry alone is cleared when the Promise is returned; an async generation gate
 *   prevents infinite subscribe / double dispose). Remount after `onUnmount` still works.
 * - `mapStateToProps` subscribe failures fail the mount; mapDispatch-only hosts still get the
 *   post-mount kick-off after a successful mount. Mounting either mode on a destroyed store fails.
 * - Nested HOC wrap `connect(...)(connect(...)(Ctor))` is rejected: inheritance shares one
 *   instance and collides connect fields, which previously stack-overflowed in `onMount`.
 *   Nest stores via parent/child context (`connect(store)(Parent)` + `connect(mapState)(Child)`).
 *
 * @module Effectable/connect/connect
 */

import type { Action } from '../store/types';
import type { Store } from '../store/types';
import { CONNECT_REBIND_LIFECYCLE, RUNTIME_PROPS_RECEIVER } from '../component/types';
import {
  CONTEXT_FIELDS_META_KEY,
  HAS_CONTEXT_FIELDS_KEY,
  IS_CONTEXT_PROVIDER,
  createContext,
  extendScope,
} from '../component/context';
import type { ContextFieldMeta, ContextScope } from '../component/context';
import type {
  MapStateToProps,
  MapDispatchToProps,
  MapDispatchToPropsFunction,
  ActionCreatorsMap,
  ConnectOptions,
  ConnectableHocTarget,
  OwnPropsMode,
} from './types';

const CONNECT_STORE_CONTEXT = createContext<unknown | null>('EFFECTABLE_CONNECT_STORE', null);
const CONNECT_STORE_CONTEXT_FIELD = '__connectStoreFromContext';

/**
 * Brand on constructors returned by {@link connect}. Used to reject nested HOC wraps
 * (`connect(...)(AlreadyConnected)`), which share one instance and recurse in `onMount`.
 */
export const CONNECT_HOC_BRAND = Symbol('effectable.connect.hocBrand');

/**
 * Default props filtering mode for `connect` when not set explicitly via {@link ConnectOptions}.
 *
 * Target `Effectable` contract: `'strict'` — parent props do not leak into public `this.props`;
 * only what mappers explicitly return ends up there. Prefer explicit pass-through mappers.
 * Legacy `'merge'` mode is enabled only explicitly via `ConnectOptions.ownPropsModeMerge: true`
 * as a documented transitional mode.
 */
const DEFAULT_OWN_PROPS_MODE: OwnPropsMode = 'strict';

/**
 * Whether `ctor` (or a superclass) was produced by {@link connect}.
 *
 * @param {Function} ctor - component constructor
 * @returns {boolean}
 */
function isConnectHocConstructor (ctor: Function): boolean {
  let current: Function | null = ctor;
  const seen = new Set<Function>();

  while (current !== null && typeof current === 'function' && !seen.has(current)) {
    seen.add(current);
    if (
      (current as { [CONNECT_HOC_BRAND]?: boolean })[CONNECT_HOC_BRAND] === true
    ) {
      return true;
    }
    const next = Object.getPrototypeOf(current);
    current = typeof next === 'function' ? next : null;
  }

  return false;
}

/**
 * Checks that a value looks like a Promise (thenable) and can be awaited asynchronously.
 *
 * @param {unknown} value - value to check
 * @returns {boolean} `true` if the object has a `then` method of type function
 */
function isPromiseLike (value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<PropertyKey, unknown>;
  return typeof record['then'] === 'function';
}

/**
 * Checks that a value looks like an Effectable store.
 *
 * @param {unknown} value - value to check
 * @returns {boolean} `true` if the object implements the required store API
 */
function isStoreLike (value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<PropertyKey, unknown>;
  return (
    typeof record['dispatch'] === 'function' &&
    typeof record['getState'] === 'function' &&
    typeof record['select'] === 'function' &&
    typeof record['destroy'] === 'function'
  );
}

/**
 * Resolves the user `onMount` / `onUnmount` connect should invoke after its own wiring.
 *
 * Order:
 * 1. Own class-field captured via CONNECT_REBIND (`ownCapturedFromSubclass`)
 *    — most specific own property on a subclass-of-Connected instance
 * 2. Nearest prototype-own hook on the chain *above* `connectedProto`
 *    (e.g. `class Ext extends Connected { override onMount() }`, or an intermediate Mid)
 * 3. Own class-field captured in the Connected constructor from the wrapped base
 * 4. Prototype-own hooks *below* `connectedProto`, then the wrapped constructor prototype
 *
 * Connected installs own lifecycle properties that shadow subclass prototype methods for
 * GraphRuntime entry; without (2), Ext.prototype overrides are skipped while store wiring
 * still runs. (2) must precede (3): a wrapped base class-field in `ownCaptured` would
 * otherwise permanently hide Ext.prototype (#93 left that gap). (1) must precede (2):
 * preferring every above-Connected prototype over any ownCaptured makes an intermediate
 * Mid.prototype beat Ext's class-field (CONNECT_REBIND capture).
 *
 * @param {object} instance - connected instance
 * @param {'onMount' | 'onUnmount'} hookName - lifecycle hook name
 * @param {(() => void | Promise<void>) | null} ownCaptured - class-field hook captured at construct / rebind
 * @param {boolean} ownCapturedFromSubclass - true when `ownCaptured` came from CONNECT_REBIND
 * @param {object} connectedProto - `Connected.prototype` (boundary for subclass vs wrapped walks)
 * @param {object} wrappedProto - wrapped component `Constructor.prototype`
 * @returns {(() => void | Promise<void>) | null} user hook, or null if none
 */
function resolveUserConnectLifecycleHook (
  instance: object,
  hookName: 'onMount' | 'onUnmount',
  ownCaptured: (() => void | Promise<void>) | null,
  ownCapturedFromSubclass: boolean,
  connectedProto: object,
  wrappedProto: object
): (() => void | Promise<void>) | null {
  // Subclass-of-Connected class-field (CONNECT_REBIND) beats Mid/Ext.prototype.
  if (ownCaptured !== null && ownCapturedFromSubclass) {
    return ownCaptured;
  }

  // Subclass-of-Connected prototype overrides beat a captured wrapped class-field.
  let proto: object | null = Object.getPrototypeOf(instance) as object | null;
  while (proto !== null && proto !== Object.prototype && proto !== connectedProto) {
    if (Object.prototype.hasOwnProperty.call(proto, hookName)) {
      const hook = (proto as Record<string, unknown>)[hookName];
      if (typeof hook === 'function') {
        return hook as () => void | Promise<void>;
      }
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  if (ownCaptured !== null) {
    return ownCaptured;
  }

  // Wrapped base prototype hooks (and further ancestors below Connected.prototype).
  proto = Object.getPrototypeOf(connectedProto) as object | null;
  while (proto !== null && proto !== Object.prototype) {
    if (Object.prototype.hasOwnProperty.call(proto, hookName)) {
      const hook = (proto as Record<string, unknown>)[hookName];
      if (typeof hook === 'function') {
        return hook as () => void | Promise<void>;
      }
    }
    proto = Object.getPrototypeOf(proto) as object | null;
  }

  const wrappedHook = (wrappedProto as Record<string, unknown>)[hookName];
  if (typeof wrappedHook === 'function') {
    return wrappedHook as () => void | Promise<void>;
  }

  return null;
}

/**
 * Adds metadata so the connected class can obtain the store from context before `onMount`.
 *
 * @param target - constructor of the dynamic connected class
 */
function attachConnectStoreContext (
  target: {
    [CONTEXT_FIELDS_META_KEY]?: ContextFieldMeta[];
    [HAS_CONTEXT_FIELDS_KEY]?: true;
  }
): void {
  const inheritedFields = target[CONTEXT_FIELDS_META_KEY];
  const nextFields = Array.isArray(inheritedFields) ? [...inheritedFields] : [];

  nextFields.push({
    propertyKey: CONNECT_STORE_CONTEXT_FIELD,
    token: CONNECT_STORE_CONTEXT,
  });

  target[CONTEXT_FIELDS_META_KEY] = nextFields;
  target[HAS_CONTEXT_FIELDS_KEY] = true;
}

/**
 * Normalizes a mapper result into a props object for further merge into the instance.
 *
 * @param {unknown} mapped - result of `mapStateToProps` or `mapDispatchToProps`
 * @returns {Record<string, unknown> | null} props dictionary, or `null` if the shape is unsupported
 */
function getMappedPropsRecord (mapped: unknown): Record<string, unknown> | null {
  if (mapped === null || typeof mapped !== 'object' || Array.isArray(mapped)) {
    return null;
  }

  return mapped as Record<string, unknown>;
}

/**
 * Converts mapDispatchToProps (function or action creators object) into a flat object for merge into props.
 *
 * Function as third argument: always called as `fn(dispatch, props)`.
 * Extra arguments are ignored by JS functions that do not use them.
 *
 * @template S store state type
 * @template P instance props type
 * @template A action type
 * @param {Store<S, A>} store - store with a `dispatch` method
 * @param {MapDispatchToProps<S, P, A> | null | undefined} mapDispatch - function or action creators object; `null`/`undefined` — nothing to merge
 * @param {P} props - current instance props (for the full `mapDispatch` form)
 * @returns {Record<string, unknown> | null} flat object of callbacks/dispatch wrappers, or `null` if nothing to merge
 */

/**
 * Shallow equality for own-props records (RUNTIME_PROPS_RECEIVER).
 * Used to avoid re-invoking mapDispatch factories when parent reconcile
 * passes a new props object with the same fields — a factory that dispatches
 * as a side effect would otherwise loop with a connected parent.
 *
 * @param {Record<string, unknown>} a - previous own props
 * @param {Record<string, unknown>} b - next own props
 * @returns {boolean} true when both have the same keys and `===` values
 */
function shallowEqualOwnProps (
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  if (a === b) {
    return true;
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) {
    return false;
  }
  for (let i = 0; i < keysA.length; i += 1) {
    const key = keysA[i] as string;
    if (!Object.prototype.hasOwnProperty.call(b, key) || a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

function resolveMapDispatchProps<S, P, A extends Action> (
  store: Store<S, A>,
  mapDispatch: MapDispatchToProps<S, P, A> | null | undefined,
  props: P
): Record<string, unknown> | null {
  if (mapDispatch == null) {
    return null;
  }

  if (typeof mapDispatch === 'function') {
    const fn = mapDispatch as MapDispatchToPropsFunction<S, P, A>;
    const out: unknown = fn(store.dispatch, props);

    if (out == null || typeof out !== 'object' || Array.isArray(out)) {
      return null;
    }

    return out as Record<string, unknown>;
  }

  const creators = mapDispatch as ActionCreatorsMap<A>;
  // Null-prototype bag so a creator named `__proto__` becomes an own property
  // instead of invoking the Object.prototype `__proto__` setter (which would
  // drop the bound action and pollute `bound`'s [[Prototype]]).
  const bound: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(creators)) {
    const ac = creators[key];
    if (typeof ac !== 'function') {
      continue;
    }

    bound[key] = (...args: unknown[]) => store.dispatch(ac(...args) as A);
  }

  return bound;
}

/**
 * Internal factory: returns an HOC that wraps the given constructor in a connected class.
 *
 * @template S store state type
 * @template P props type of the wrapped component
 * @template R result type of `mapStateToProps`
 * @template A action type
 * @param {Store<S, A> | null} explicitStore - explicitly passed store for a root-connected node, or `null`
 *   for a child node that will receive the store from context
 * @param {MapStateToProps<S, P, R> | undefined | null} mapStateToProps - state → props selector, or no subscription
 * @param {MapDispatchToProps<S, P, A> | undefined | null} mapDispatchToProps - binding dispatch to prop methods
 * @returns {<C extends ConnectableHocTarget>(Constructor: C) => C} function `(Ctor) => Ctor-subclass` with subscription and merge into `props`
 */
function buildConnectHoc<S, P, R, A extends Action> (
  explicitStore: Store<S, A> | null,
  mapStateToProps: MapStateToProps<S, P, R> | undefined | null,
  mapDispatchToProps: MapDispatchToProps<S, P, A> | undefined | null,
  ownPropsMode: OwnPropsMode
): <C extends ConnectableHocTarget>(Constructor: C) => C {
  return function connectHoc<C extends ConnectableHocTarget> (
    Constructor: C
  ): C {
    // Nested `connect(...)(connect(...)(Ctor))` shares one instance: outer field
    // initializers wipe inner connect state, and capturing the inner own `onMount`
    // as `__connectOwnOnMount` makes `onMount` recurse until the stack overflows.
    // Parent/child context nesting remains the supported pattern.
    if (isConnectHocConstructor(Constructor)) {
      throw new Error(
        '[Effectable.connect] Cannot wrap an already-connected component. ' +
        'Combine mapState/mapDispatch in a single connect() call, or nest via ' +
        'parent/child context (connect(store)(Parent) + connect(mapState)(Child)).'
      );
    }

    type BaseShape = {
      props: Record<string, unknown>;
      setState (u: object): void;
      onMount? (): void | Promise<void>;
      onUnmount? (): void | Promise<void>;
    };
    const BaseCtor = Constructor as unknown as new (props: P) => BaseShape;

    /**
     * Subclass of the original component: on mount merges dispatch props; when `mapStateToProps` is present
     * subscribes to `store.select` and updates `props` + `setState` after the first selector pass.
     */
    class Connected extends BaseCtor {
      private __connectSubscription: { unsubscribe: () => void } | null = null;
      private __connectPrevMapped: unknown = undefined;
      private __connectFirstPass = true;
      private __connectMountCompleted = false;
      private __connectPendingUpdate = false;
      /**
       * After mount completed, at least one `onUpdate` was delivered via `setState`
       * (pending flush or store emit). Needed so the post-mount kick-off does not duplicate a pass.
       */
      private __connectDeliveredUpdateAfterMount = false;
      /** Kick-off via `queueMicrotask` has already been queued (exactly once per mount). */
      private __connectKickoffScheduled = false;
      /**
       * Set in `onUnmount` so an in-flight async `super.onMount` cannot call
       * `completeConnectMount` / `deliverConnectUpdate` after teardown.
       */
      private __connectTornDown = false;
      /**
       * Set when the store observable completes (typically `store.destroy()`).
       * Reconcile must not call `getState()` on a destroyed store — that throw fail-stops
       * the entire GraphRuntime. Last mapped props are kept until unmount/remount.
       */
      private __connectStoreDestroyed = false;
      /**
       * Bumped at the start of every `onMount`. Async `super.onMount` completions capture the
       * generation so a stale promise from a previous mount cannot complete / kick off after
       * remount cleared `__connectTornDown` while the new mount is still pending.
       */
      private __connectMountGeneration = 0;
      private __connectStore: Store<S, A> | null = explicitStore;
      private __connectStoreFromContext: unknown = undefined;
      private __connectOwnProps: Record<string, unknown>;
      private __connectStateProps: Record<string, unknown> | null = null;
      private __connectDispatchProps: Record<string, unknown> | null = null;
      /**
       * User `onMount` / `onUnmount` installed as class fields (own instance properties).
       * Those shadow `Connected.prototype` hooks unless captured and reinstalled below.
       */
      private __connectOwnOnMount: (() => void | Promise<void>) | null = null;
      private __connectOwnOnUnmount: (() => void | Promise<void>) | null = null;
      /**
       * True when the corresponding `__connectOwnOn*` capture came from CONNECT_REBIND
       * (subclass-of-Connected class field), not from the Connected constructor (wrapped base).
       */
      private __connectOwnOnMountFromSubclass = false;
      private __connectOwnOnUnmountFromSubclass = false;
      /**
       * True while Connected mount wiring is on the sync stack. Makes subclass
       * `super.onMount()` (Connected.prototype) a safe no-op. Own-entry
       * `this.onMount()` / GraphRuntime still remount via `__connectEntryOnMount`.
       * Cleared when `onMount` returns — including when it returns a Promise — so it
       * alone cannot cover `await …; await super.onMount()` (see `__connectMountAsyncGateGen`).
       */
      private __connectMountReentry = false;
      /**
       * Mount generation for which an async Connected `onMount` Promise is in flight.
       * Blocks `super.onMount()` after `await` from re-entering wiring (infinite
       * subscribe / OOM). Cleared when the Promise settles or on `onUnmount` so a
       * real remount is not treated as reentry.
       */
      private __connectMountAsyncGateGen = 0;
      /**
       * True while Connected unmount teardown is on the sync stack. Makes subclass
       * `super.onUnmount()` a safe no-op. Own-entry `this.onUnmount()` still runs
       * via `__connectEntryOnUnmount` (nested save/restore of this flag).
       */
      private __connectUnmountReentry = false;
      /**
       * True while an async Connected `onUnmount` Promise is in flight. Blocks
       * `super.onUnmount()` after `await` from re-running teardown.
       */
      private __connectUnmountAsyncGate = false;
      /**
       * Stable own-property mount entry (GraphRuntime / `this.onMount()`). Distinct from
       * `Connected.prototype.onMount` so `super.onMount()` can no-op on reentry while
       * nested remount via `this.onMount()` still runs.
       */
      private __connectEntryOnMount: () => void | Promise<void>;
      /**
       * Stable own-property unmount entry (GraphRuntime / `this.onUnmount()`).
       */
      private __connectEntryOnUnmount: () => void | Promise<void>;

      constructor (props: P) {
        super(props);
        this.__connectOwnProps = this.props as unknown as Record<string, unknown>;

        // Own entries must stay !== Connected.prototype hooks so installConnectLifecycleHooks
        // never re-captures them as user class-field hooks on rebind.
        this.__connectEntryOnMount = () => this.enterConnectOnMount();
        this.__connectEntryOnUnmount = () => this.enterConnectOnUnmount();

        // Class-field lifecycle hooks are own properties and shadow Connected.prototype.
        // Capture BaseCtor fields here, then reinstall Connected wiring. Subclass-of-Connected
        // class fields initialize *after* this constructor and can overwrite the wiring again;
        // GraphRuntime calls CONNECT_REBIND_LIFECYCLE post-construct to re-capture those.
        this.installConnectLifecycleHooks(false);
        (this as unknown as Record<symbol, unknown>)[CONNECT_REBIND_LIFECYCLE] = () => {
          this.installConnectLifecycleHooks(true);
        };
      }

      /**
       * Captures any own `onMount` / `onUnmount` that is not Connected wiring, then
       * reinstalls own-entry Connected hooks (not prototype methods — see mount reentry).
       *
       * Safe to call from the Connected constructor (BaseCtor class fields) and again
       * after full construction (subclass-of-Connected class fields).
       *
       * @param {boolean} fromSubclassRebind - true when invoked via CONNECT_REBIND after
       *   subclass construction (marks captures as subclass-origin for resolve order)
       * @returns {void}
       */
      private installConnectLifecycleHooks (fromSubclassRebind: boolean): void {
        const self = this as {
          onMount?: unknown;
          onUnmount?: unknown;
        };
        const protoMount = Connected.prototype.onMount;
        const protoUnmount = Connected.prototype.onUnmount;
        const entryMount = this.__connectEntryOnMount;
        const entryUnmount = this.__connectEntryOnUnmount;
        if (
          Object.prototype.hasOwnProperty.call(this, 'onMount') &&
          typeof self.onMount === 'function' &&
          self.onMount !== protoMount &&
          self.onMount !== entryMount
        ) {
          this.__connectOwnOnMount = self.onMount as () => void | Promise<void>;
          this.__connectOwnOnMountFromSubclass = fromSubclassRebind;
        }
        if (
          Object.prototype.hasOwnProperty.call(this, 'onUnmount') &&
          typeof self.onUnmount === 'function' &&
          self.onUnmount !== protoUnmount &&
          self.onUnmount !== entryUnmount
        ) {
          this.__connectOwnOnUnmount = self.onUnmount as () => void | Promise<void>;
          this.__connectOwnOnUnmountFromSubclass = fromSubclassRebind;
        }
        self.onMount = entryMount;
        self.onUnmount = entryUnmount;
      }

      /**
       * Runs connect mount wiring. Nested own-entry remount saves/restores the reentry
       * flag so an outer `super.onMount()` guard stays active afterward.
       *
       * @returns {void | Promise<void>}
       */
      private enterConnectOnMount (): void | Promise<void> {
        const wasReentry = this.__connectMountReentry;
        this.__connectMountReentry = true;
        let asyncMount = false;
        try {
          const result = this.runConnectOnMount();
          if (isPromiseLike(result)) {
            asyncMount = true;
            const mountGeneration = this.__connectMountGeneration;
            this.__connectMountAsyncGateGen = mountGeneration;
            return Promise.resolve(result as Promise<void>).finally(() => {
              if (this.__connectMountAsyncGateGen === mountGeneration) {
                this.__connectMountAsyncGateGen = 0;
              }
            });
          }
          return result;
        } finally {
          this.__connectMountReentry = wasReentry;
          if (!asyncMount) {
            this.__connectMountAsyncGateGen = 0;
          }
        }
      }

      /**
       * Runs connect unmount teardown with nested save/restore of the reentry flag.
       *
       * @returns {void | Promise<void>}
       */
      private enterConnectOnUnmount (): void | Promise<void> {
        const wasReentry = this.__connectUnmountReentry;
        this.__connectUnmountReentry = true;
        let asyncUnmount = false;
        try {
          const result = this.runConnectOnUnmount();
          if (isPromiseLike(result)) {
            asyncUnmount = true;
            this.__connectUnmountAsyncGate = true;
            return Promise.resolve(result as Promise<void>).finally(() => {
              this.__connectUnmountAsyncGate = false;
            });
          }
          return result;
        } finally {
          this.__connectUnmountReentry = wasReentry;
          if (!asyncUnmount) {
            this.__connectUnmountAsyncGate = false;
          }
        }
      }

      /**
       * User lifecycle hook for this instance: class field, Connected-subclass prototype
       * override, or wrapped constructor prototype.
       *
       * @param {'onMount' | 'onUnmount'} hookName
       * @returns {(() => void | Promise<void>) | null}
       */
      private resolveUserLifecycleHook (
        hookName: 'onMount' | 'onUnmount'
      ): (() => void | Promise<void>) | null {
        return resolveUserConnectLifecycleHook(
          this,
          hookName,
          hookName === 'onMount' ? this.__connectOwnOnMount : this.__connectOwnOnUnmount,
          hookName === 'onMount'
            ? this.__connectOwnOnMountFromSubclass
            : this.__connectOwnOnUnmountFromSubclass,
          Connected.prototype,
          Constructor.prototype as object
        );
      }

      /**
       * Delivers an update-pass via `setState({})` and marks that the post-mount kick-off
       * is no longer needed (avoids a double onUpdate).
       *
       * @returns {void}
       */
      private deliverConnectUpdate (): void {
        this.__connectDeliveredUpdateAfterMount = true;
        this.setState({});
      }

      /**
       * Schedules one deferred `onUpdate` kick-off after mount completes.
       *
       * Microtask (not sync): right after `onMount` the immediate post-mount contract is preserved
       * (`['mount:…']` without update), and by the time of the microtask GraphRuntime has already injected
       * `SCHEDULE_UPDATE_HOOK`, so the kick-off also rebuilds `compose()`.
       *
       * Used for both `mapStateToProps` and `mapDispatchToProps`: GraphRuntime runs `compose()`
       * during materialization before `onMount`, so children would otherwise keep stale/undefined
       * mapped props until a later store emit or manual `setState`.
       *
       * Unmount cancel: `__connectMountCompleted` is cleared in `onUnmount` (mapDispatch-only
       * has no subscription to null out).
       *
       * @returns {void}
       */
      private schedulePostMountKickoff (): void {
        if (this.__connectKickoffScheduled) {
          return;
        }

        this.__connectKickoffScheduled = true;
        queueMicrotask(() => {
          if (!this.__connectMountCompleted) {
            return;
          }

          if (this.__connectDeliveredUpdateAfterMount) {
            return;
          }

          this.deliverConnectUpdate();
        });
      }

      /**
       * Completes mount: flush any pending store emit deferred during `onMount`, then schedule post-mount kick-off.
       *
       * @returns {void}
       */
      private completeConnectMount (): void {
        // Unmounted while async super.onMount was still pending: drop deferred work.
        if (this.__connectTornDown) {
          this.__connectPendingUpdate = false;
          this.__connectMountCompleted = false;
          return;
        }

        this.__connectMountCompleted = true;

        if (this.__connectPendingUpdate) {
          this.__connectPendingUpdate = false;
          this.deliverConnectUpdate();
        }

        this.schedulePostMountKickoff();
      }

      /**
       * Publishes the resolved store into the connected component's subtree.
       *
       * GraphRuntime calls this during materialization **before** the first `compose()`,
       * and again on update / dirty reconcile. Mapped props are synced only while mount
       * has not completed yet — that closes the strict first-compose own-props leak
       * without re-running `mapDispatch` on every dirty flush (a factory that dispatches
       * as a side effect would otherwise loop: dispatch → select → setState → dirty
       * reconcile → applyToScope → dispatch → … → fail-stop).
       *
       * After mount, props stay current via the store subscription and
       * {@link RUNTIME_PROPS_RECEIVER}; post-mount `applyToScope` only republishes the store
       * (still after delegating to the wrapped class's `applyToScope` when present).
       *
       * After `store.destroy()`, skip live `getState()` / mapDispatch refresh — that throw
       * would fail-stop the entire GraphRuntime on the next parent `setState`. Keep last
       * mapped props and still publish the cached store reference for context identity.
       *
       * @param {ContextScope} parentScope - parent scope
       * @returns {ContextScope} scope for child nodes
       */
      public applyToScope (parentScope: ContextScope): ContextScope {
        // Preserve the wrapped class's applyToScope (ContextProvider or a custom
        // context publisher). Skipping super silently drops user tokens from the
        // child scope while CONNECT_STORE_CONTEXT still publishes — children see
        // token defaults instead of the intended provider values.
        const baseApply = (
          Constructor.prototype as { applyToScope?: (scope: ContextScope) => ContextScope }
        ).applyToScope;
        const scopeForChildren =
          typeof baseApply === 'function'
            ? baseApply.call(this, parentScope)
            : parentScope;

        const store = this.tryResolveConnectStore();
        if (store !== null) {
          // Pre-mount only (#91): first compose runs before onMount, so own-props must
          // be stripped / mapped here. Never re-sync on dirty/update flushes after mount —
          // a mapDispatch factory that dispatches as a side effect would loop with select.
          if (!this.__connectMountCompleted) {
            this.syncConnectPropsBeforeCompose(store);
          }
          return extendScope(scopeForChildren, CONNECT_STORE_CONTEXT, store);
        }

        // Destroyed store: do not call getState(); keep last mapped props.
        if (this.__connectStoreDestroyed && this.__connectStore !== null) {
          return extendScope(scopeForChildren, CONNECT_STORE_CONTEXT, this.__connectStore);
        }

        // Missing store (never resolved) — same public error as before.
        const resolved = this.resolveConnectStore();
        if (!this.__connectMountCompleted) {
          this.syncConnectPropsBeforeCompose(resolved);
        }
        return extendScope(scopeForChildren, CONNECT_STORE_CONTEXT, resolved);
      }

      /**
       * Applies dispatch + current mapState props before the first `compose()`.
       *
       * @param {Store<S, A>} store - resolved store
       * @returns {void}
       */
      private syncConnectPropsBeforeCompose (store: Store<S, A>): void {
        this.refreshDispatchProps(store);
        if (mapStateToProps != null) {
          this.applyMappedStateProps(
            mapStateToProps(store.getState(), this.__connectOwnProps as unknown as P)
          );
        } else {
          // mapState path already probes liveness via getState() above. mapDispatch-only
          // (and mapper-less) connect must reject a destroyed store before first compose —
          // otherwise GraphRuntime mounts ACTIVE with dead dispatch props.
          store.getState();
        }
      }

      /**
       * Returns the store from the explicit `connect(store, ...)` argument or from the context
       * of the nearest connected ancestor.
       *
       * @returns {Store<S, A>} resolved store
       */
      private resolveConnectStore (): Store<S, A> {
        if (this.__connectStore !== null) {
          return this.__connectStore;
        }

        if (isStoreLike(this.__connectStoreFromContext)) {
          this.__connectStore = this.__connectStoreFromContext as Store<S, A>;
          return this.__connectStore;
        }

        throw new Error(
          '[Effectable.connect] Store is not available. ' +
          'Use connect(store, ...) for the root connected component or mount this component under a connected parent.'
        );
      }

      /**
       * Attempts to obtain the store without throwing.
       *
       * Used on the reconcile path so props can be updated even if the store has not yet been
       * fully cached.
       *
       * @returns {Store<S, A> | null}
       */
      private tryResolveConnectStore (): Store<S, A> | null {
        // After store.destroy(), getState()/dispatch throw. Treat as unresolved for reconcile
        // so RUNTIME_PROPS_RECEIVER rebuilds from last mapped props instead of fail-stopping.
        if (this.__connectStoreDestroyed) {
          return null;
        }

        if (this.__connectStore !== null) {
          // Belt-and-suspenders: if subscription was already dropped, complete may not run.
          try {
            this.__connectStore.getState();
          } catch {
            this.__connectStoreDestroyed = true;
            return null;
          }
          return this.__connectStore;
        }

        if (isStoreLike(this.__connectStoreFromContext)) {
          this.__connectStore = this.__connectStoreFromContext as Store<S, A>;
          return this.__connectStore;
        }

        return null;
      }

      /**
       * Builds the instance's final `props` from already computed mapped groups.
       *
       * Overlay order: dispatch props -> state props (stateProps override dispatchProps,
       * as they are closer to the selector result).
       *
       * Base layer depends on {@link OwnPropsMode}:
       * - `'merge'`: base is parent props (legacy: props automatically appear in `this.props`);
       * - `'strict'`: base is an empty object — parent props do NOT leak into public `this.props`;
       *   only what mappers explicitly returned appears there.
       *
       * @returns {void}
       */
      private rebuildConnectProps (): void {
        let nextProps: Record<string, unknown> = ownPropsMode === 'strict'
          ? {}
          : this.__connectOwnProps;

        if (this.__connectDispatchProps !== null) {
          nextProps = {
            ...nextProps,
            ...this.__connectDispatchProps,
          };
        }

        if (this.__connectStateProps !== null) {
          nextProps = {
            ...nextProps,
            ...this.__connectStateProps,
          };
        }

        this.props = nextProps;
      }

      /**
       * Recomputes dispatch props based on current props.
       *
       * @param {Store<S, A>} store
       * @returns {void}
       */
      private refreshDispatchProps (store: Store<S, A>): void {
        this.__connectDispatchProps = resolveMapDispatchProps(
          store,
          mapDispatchToProps,
          this.__connectOwnProps as unknown as P
        );
        this.rebuildConnectProps();
      }

      /**
       * Applies a new object from `mapStateToProps` as the current state-derived props.
       *
       * @param {unknown} mapped
       * @returns {boolean} `true` if state-derived props actually updated
       */
      private applyMappedStateProps (mapped: unknown): boolean {
        if (mapped === this.__connectPrevMapped) {
          return false;
        }

        const mappedProps = getMappedPropsRecord(mapped);
        if (mappedProps === null) {
          // Non-object mapState results are ignored on first apply, but a later
          // null/array/primitive must clear previously applied state props.
          // Otherwise logout-style mappers leave revoked fields on this.props
          // (remount already cleared via __connectStateProps = null; live emits did not).
          this.__connectPrevMapped = mapped;
          if (this.__connectStateProps === null) {
            return false;
          }
          this.__connectStateProps = null;
          this.rebuildConnectProps();
          return true;
        }

        this.__connectPrevMapped = mapped;
        this.__connectStateProps = mappedProps;
        this.rebuildConnectProps();
        return true;
      }

      /**
       * Tears down the active store subscription if it exists.
       *
       * @returns {void}
       */
      private disposeConnectSubscription (): void {
        if (this.__connectSubscription !== null) {
          this.__connectSubscription.unsubscribe();
          this.__connectSubscription = null;
        }
      }

      /**
       * Updates props from GraphRuntime.reconcile and synchronously rebuilds merged props.
       *
       * Parent props are applied synchronously on the update path. When `mapStateToProps` is present
       * it is recomputed synchronously on the new props (`mapStateToProps(store.getState(), nextProps)`)
       * before the next `onUpdate`/`compose()`, without waiting for the next store emission.
       * This eliminates stale state-derived props on reconcile.
       *
       * @param {P} nextProps
       * @returns {void}
       */
      public [RUNTIME_PROPS_RECEIVER] (nextProps: P): void {
        const nextOwnProps = nextProps as unknown as Record<string, unknown>;
        // Parent compose always allocates a new props object. Re-running mapDispatch
        // when own-props are shallow-equal re-enters factories that dispatch as a
        // side effect: dispatch → parent select → setState → dirty parent → child
        // UPDATE → RUNTIME_PROPS_RECEIVER → dispatch → … → GraphRuntime fail-stop.
        // Distinct from applyToScope dirty re-sync (#91): this path is props receive.
        const ownPropsChanged = !shallowEqualOwnProps(this.__connectOwnProps, nextOwnProps);
        this.__connectOwnProps = nextOwnProps;
        const store = this.tryResolveConnectStore();

        if (store !== null) {
          if (mapStateToProps != null) {
            const nextMapped = mapStateToProps(
              store.getState(),
              this.__connectOwnProps as unknown as P
            );
            this.applyMappedStateProps(nextMapped);
          }

          // Only re-bind dispatch when own-props actually changed. Factories that
          // close over own-props must re-run; pure (dispatch)=>… factories and
          // action-creator maps stay stable across parent identity-only updates.
          if (ownPropsChanged) {
            this.refreshDispatchProps(store);
          }
          return;
        }

        this.rebuildConnectProps();
      }

      /**
       * Prototype entry used by subclass `super.onMount()`. GraphRuntime and
       * `this.onMount()` use `__connectEntryOnMount` instead so nested remount works
       * while `super.onMount()` during an active mount remains a no-op.
       *
       * @returns {void | Promise<void>} synchronously or a Promise if the superclass `onMount` is async
       */
      public override onMount (): void | Promise<void> {
        // Sync reentry: subclass `super.onMount()` while Connected wiring is on the stack.
        // Remount via `this.onMount()` uses `__connectEntryOnMount` (#114); do not
        // weaken this gate with a torn-down exception.
        if (this.__connectMountReentry) {
          return;
        }
        // Async reentry: after `await`, sync reentry is already cleared. Without this gate,
        // `await …; await super.onMount()` re-enters runConnectOnMount → nested user hook →
        // infinite subscribe (OOM). Held only for the in-flight mount generation; onUnmount
        // clears it so remount is not blocked.
        if (
          this.__connectMountAsyncGateGen !== 0 &&
          this.__connectMountAsyncGateGen === this.__connectMountGeneration
        ) {
          return;
        }

        return this.enterConnectOnMount();
      }

      /**
       * Connect `onMount` body (store wiring + user hook). Split from the reentry gate.
       *
       * @returns {void | Promise<void>}
       */
      private runConnectOnMount (): void | Promise<void> {
        // Remount on the same instance must restart the first-pass / kick-off state machine.
        // PR #59 reset only `__connectTornDown`; leaving `__connectFirstPass` false skipped
        // user `onMount` and froze store→props delivery (`__connectMountCompleted` never set).
        this.__connectTornDown = false;
        this.__connectStoreDestroyed = false;
        this.__connectFirstPass = true;
        this.__connectKickoffScheduled = false;
        this.__connectDeliveredUpdateAfterMount = false;
        this.__connectPendingUpdate = false;
        this.__connectMountCompleted = false;
        this.__connectPrevMapped = undefined;
        this.__connectMountGeneration += 1;
        const mountGeneration = this.__connectMountGeneration;
        // Drop state props from the previous mount. Otherwise refreshDispatchProps
        // rebuilds with stale mapped fields, and a first emission that returns a
        // non-object (null/array) leaves those fields stuck on this.props.
        this.__connectStateProps = null;
        // Child-connected nodes cache the store resolved from context. Remount under a
        // different provider must re-resolve; reset to the explicit store (null for children).
        this.__connectStore = explicitStore;
        this.disposeConnectSubscription();
        const store = this.resolveConnectStore();
        this.refreshDispatchProps(store);

        // Class-field, Connected-subclass prototype override, or wrapped prototype.
        const superOnMount = this.resolveUserLifecycleHook('onMount');
        const hasSuperOnMount = typeof superOnMount === 'function';

        if (mapStateToProps == null) {
          // Parity with mapState destroyed-store mount (#87): without a select subscription
          // there is no complete-without-next signal, so probe getState() here as well
          // (covers mounts that skipped applyToScope sync).
          store.getState();

          /**
           * Completes the mapState-null mount path and, when dispatch props exist, schedules
           * the same post-mount compose rebuild as the mapState path.
           *
           * @returns {void}
           */
          const finishDispatchOnlyMount = (): void => {
            // Unmounted or superseded by a newer onMount while async super.onMount was pending.
            if (this.__connectTornDown || this.__connectMountGeneration !== mountGeneration) {
              return;
            }

            this.__connectMountCompleted = true;
            if (mapDispatchToProps != null) {
              this.schedulePostMountKickoff();
            }
          };

          if (!hasSuperOnMount) {
            finishDispatchOnlyMount();
            return;
          }

          const mountResult = (superOnMount as () => void | Promise<void>).call(this);
          if (isPromiseLike(mountResult)) {
            return Promise.resolve(mountResult as Promise<void>).then(() => {
              finishDispatchOnlyMount();
            }, (error: unknown) => {
              if (this.__connectMountGeneration === mountGeneration) {
                this.__connectMountCompleted = false;
              }
              throw error;
            });
          }

          finishDispatchOnlyMount();
          return;
        }

        // Selector / mapStateToProps throw during subscribe (first BehaviorSubject emission)
        // or before mount completes: surface as onMount failure instead of a zombie ACTIVE tree.
        let syncSubscribeError: unknown = null;

        const selector = (state: S): R => mapStateToProps(
          state,
          this.__connectOwnProps as unknown as P
        );

        // First select emission only applies mapped props. User `onMount` runs AFTER
        // `subscribe()` returns so a nested `dispatch` + throwing `mapStateToProps` is not a
        // reentrant observer error (RxJS `reportUnhandledError` / process crash) and cannot
        // orphan a Promise that `onMount` never returned to the caller.
        //
        // Capture the Subscription locally before assigning to the instance field (#83): a
        // teardown or nested remount during the sync first emission must not resurrect a
        // disposed handle or overwrite a newer remount's subscription.
        const subscription = store.select(selector).subscribe({
          next: (mapped: R) => {
            this.applyMappedStateProps(mapped);

            if (this.__connectFirstPass) {
              this.__connectFirstPass = false;
              return;
            }

            if (this.__connectTornDown) {
              return;
            }

            if (!this.__connectMountCompleted) {
              this.__connectPendingUpdate = true;
              return;
            }

            this.deliverConnectUpdate();
          },
          error: (error: unknown) => {
            // First-pass or pre-complete failures must fail mount (handled after subscribe returns
            // when sync, or via the pending mount promise when async).
            if (this.__connectFirstPass || !this.__connectMountCompleted) {
              syncSubscribeError = error;
              return;
            }
            // Post-mount selector errors terminate this subscription (RxJS contract).
            // The component keeps last mapped props; callers should treat mapper throws as bugs.
          },
          complete: () => {
            // store.destroy() completes select(); mark dead so later reconcile skips getState().
            this.__connectStoreDestroyed = true;
            this.__connectSubscription = null;
            // Destroyed store (or any completed-without-next select): BehaviorSubject.complete()
            // means new subscribers get complete only — no first `next`. Without this, connect
            // would return successfully, skip user onMount, and leave GraphRuntime ACTIVE.
            if (this.__connectFirstPass || !this.__connectMountCompleted) {
              syncSubscribeError = new Error(
                '[Effectable.connect] Store select completed before the first state emission ' +
                '(store may have been destroyed).'
              );
            }
          },
        });

        if (this.__connectMountGeneration !== mountGeneration) {
          // Nested remount already installed a newer subscription — drop only ours.
          subscription.unsubscribe();
        } else {
          this.__connectSubscription = subscription;
          if (
            this.__connectTornDown ||
            syncSubscribeError !== null
          ) {
            this.disposeConnectSubscription();
          }
        }

        if (syncSubscribeError !== null) {
          throw syncSubscribeError;
        }

        // Nested remount during subscribe owns the instance — do not run this mount's onMount.
        if (this.__connectMountGeneration !== mountGeneration) {
          return;
        }

        if (!hasSuperOnMount) {
          this.completeConnectMount();
          return;
        }

        let mountResult: void | Promise<void>;
        try {
          mountResult = (superOnMount as () => void | Promise<void>).call(this);
        } catch (error: unknown) {
          this.disposeConnectSubscription();
          throw error;
        }

        // Nested remount during user onMount owns the instance.
        if (this.__connectMountGeneration !== mountGeneration) {
          return;
        }

        // Nested store emit during sync super.onMount may have errored the subscription.
        if (syncSubscribeError !== null) {
          this.disposeConnectSubscription();
          if (isPromiseLike(mountResult)) {
            // Suppress orphan rejection — caller receives the syncSubscribeError throw instead.
            void Promise.resolve(mountResult as Promise<void>).then(() => undefined, () => undefined);
          }
          throw syncSubscribeError;
        }

        if (!isPromiseLike(mountResult)) {
          this.completeConnectMount();
          return;
        }

        return Promise.resolve(mountResult as Promise<void>).then(() => {
          if (this.__connectMountGeneration !== mountGeneration) {
            return;
          }
          if (syncSubscribeError !== null) {
            this.disposeConnectSubscription();
            this.__connectPendingUpdate = false;
            throw syncSubscribeError;
          }
          this.completeConnectMount();
        }, (error: unknown) => {
          if (this.__connectMountGeneration !== mountGeneration) {
            throw error;
          }
          this.disposeConnectSubscription();
          this.__connectPendingUpdate = false;
          throw error;
        });
      }

      /**
       * Prototype entry used by subclass `super.onUnmount()`. GraphRuntime and
       * `this.onUnmount()` use `__connectEntryOnUnmount` instead.
       *
       * @returns {void | Promise<void>}
       */
      public override onUnmount (): void | Promise<void> {
        // Allow remount while a prior async onMount Promise is still settling — that
        // Promise must not keep the async mount gate closed across onUnmount→onMount.
        this.__connectMountAsyncGateGen = 0;

        // Sync reentry: subclass `super.onUnmount()` while Connected teardown is on the stack.
        if (this.__connectUnmountReentry) {
          return;
        }
        // Async reentry: `await …; await super.onUnmount()` must not re-run teardown.
        if (this.__connectUnmountAsyncGate) {
          return;
        }

        return this.enterConnectOnUnmount();
      }

      /**
       * Connect `onUnmount` body (dispose + user hook). Split from the reentry gate.
       *
       * @returns {void | Promise<void>}
       */
      private runConnectOnUnmount (): void | Promise<void> {
        this.__connectTornDown = true;
        this.__connectPendingUpdate = false;
        // Cancels a pending post-mount kick-off (mapDispatch-only has no subscription to null out).
        this.__connectMountCompleted = false;
        this.disposeConnectSubscription();

        const superOnUnmount = this.resolveUserLifecycleHook('onUnmount');
        if (typeof superOnUnmount !== 'function') {
          return;
        }

        const result = (superOnUnmount as () => void | Promise<void>).call(this);
        if (isPromiseLike(result)) {
          return result as Promise<void>;
        }
      }
    }

    Object.defineProperty(Connected.prototype, IS_CONTEXT_PROVIDER, {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    if (explicitStore === null) {
      attachConnectStoreContext(
        Connected as typeof Connected & {
          [CONTEXT_FIELDS_META_KEY]?: ContextFieldMeta[];
          [HAS_CONTEXT_FIELDS_KEY]?: true;
        }
      );
    }

    Object.defineProperty(Connected, 'name', {
      value: Constructor.name,
      configurable: true,
    });

    Object.defineProperty(Connected, CONNECT_HOC_BRAND, {
      value: true,
      writable: false,
      enumerable: false,
      configurable: false,
    });

    return Connected as unknown as C;
  };
}

/**
 * Connects a component class to the store (class-based HOC): merge into `props` from state and/or dispatch.
 * Supports two forms:
 * - `connect(store, mapState?, mapDispatch?)` for a root connected component;
 * - `connect(mapState?, mapDispatch?)` for a child connected component that receives the store from context.
 *
 * Remount and class-field lifecycle follow the module contracts above (identity-safe wiring,
 * no skipped subscribe/unsubscribe when hooks are declared as class fields).
 *
 * @template S store state type
 * @template P props type of the connected component
 * @template R result type of `mapStateToProps`
 * @template A action type
 * @param {Store<S, A> | MapStateToProps<S, P, R> | null | undefined} [storeOrMapStateToProps] - explicit store or `mapStateToProps`
 * @param {MapStateToProps<S, P, R> | MapDispatchToProps<S, P, A> | null | undefined} [mapStateToPropsOrMapDispatchToProps] - `mapStateToProps` or `mapDispatchToProps`
 * @param {MapDispatchToProps<S, P, A> | ConnectOptions | null | undefined} [mapDispatchToPropsOrOptions] - `mapDispatchToProps` or {@link ConnectOptions}
 * @param {ConnectOptions} [maybeOptions] - {@link ConnectOptions} (e.g. `ownPropsModeMerge`) for the form with an explicit store
 * @returns {<C extends ConnectableHocTarget>(Constructor: C) => C} HOC: `(Ctor) => subclass of C` with the same constructor name
 */
export function connect<S, P = unknown, R = unknown, A extends Action = Action> (
  storeOrMapStateToProps?: Store<S, A> | MapStateToProps<S, P, R> | null,
  mapStateToPropsOrMapDispatchToProps?: MapStateToProps<S, P, R> | MapDispatchToProps<S, P, A> | null,
  mapDispatchToPropsOrOptions?: MapDispatchToProps<S, P, A> | ConnectOptions | null,
  maybeOptions?: ConnectOptions
): <C extends ConnectableHocTarget>(Constructor: C) => C {
  let store: Store<S, A> | null = null;
  let mapStateToProps: MapStateToProps<S, P, R> | undefined;
  let mapDispatchToProps: MapDispatchToProps<S, P, A> | undefined;
  let options: ConnectOptions | undefined;

  if (isStoreLike(storeOrMapStateToProps)) {
    store = storeOrMapStateToProps as Store<S, A>;
    mapStateToProps = mapStateToPropsOrMapDispatchToProps as MapStateToProps<S, P, R> | undefined;
    mapDispatchToProps = mapDispatchToPropsOrOptions as MapDispatchToProps<S, P, A> | undefined;
    options = maybeOptions;
  } else {
    mapStateToProps = storeOrMapStateToProps as MapStateToProps<S, P, R> | undefined;
    mapDispatchToProps = mapStateToPropsOrMapDispatchToProps as MapDispatchToProps<S, P, A> | undefined;
    options = mapDispatchToPropsOrOptions as ConnectOptions | undefined;
  }

  const ownPropsMode: OwnPropsMode = options !== undefined && options.ownPropsModeMerge === true
    ? 'merge'
    : DEFAULT_OWN_PROPS_MODE;

  return buildConnectHoc(
    store,
    mapStateToProps ?? undefined,
    mapDispatchToProps ?? undefined,
    ownPropsMode
  );
}
