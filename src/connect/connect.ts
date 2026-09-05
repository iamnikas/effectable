/**
 * HOC connect: connects a component class to the store via mapStateToProps and/or mapDispatchToProps,
 * implemented as a class-based wrapper over the original class.
 *
 * Call: `connect(store, mapState?, mapDispatch?)(Ctor)`.
 * Third argument: full function `(dispatch, props) => …`, short `(dispatch) => …`,
 * or an object of action creators `{ key: (...args) => action }` (see `resolveMapDispatchProps`).
 *
 * @module Effectable/connect/connect
 */

import type { Action } from '../store/types';
import type { Store } from '../store/types';
import { RUNTIME_PROPS_RECEIVER } from '../component/types';
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
 * Default props filtering mode for `connect` when not set explicitly via {@link ConnectOptions}.
 *
 * Target `Effectable` contract: `'strict'` — parent props do not leak into public `this.props`;
 * only what mappers explicitly return ends up there. Prefer explicit pass-through mappers.
 * Legacy `'merge'` mode is enabled only explicitly via `ConnectOptions.ownPropsModeMerge: true`
 * as a documented transitional mode.
 */
const DEFAULT_OWN_PROPS_MODE: OwnPropsMode = 'strict';

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
  const bound: Record<string, unknown> = {};
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

      constructor (props: P) {
        super(props);
        this.__connectOwnProps = this.props as unknown as Record<string, unknown>;
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
       * @param {ContextScope} parentScope - parent scope
       * @returns {ContextScope} scope for child nodes
       */
      public applyToScope (parentScope: ContextScope): ContextScope {
        return extendScope(parentScope, CONNECT_STORE_CONTEXT, this.resolveConnectStore());
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
        if (this.__connectStore !== null) {
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
          return false;
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
        this.__connectOwnProps = nextProps as unknown as Record<string, unknown>;
        const store = this.tryResolveConnectStore();

        if (store !== null) {
          if (mapStateToProps != null) {
            const nextMapped = mapStateToProps(
              store.getState(),
              this.__connectOwnProps as unknown as P
            );
            this.applyMappedStateProps(nextMapped);
          }

          this.refreshDispatchProps(store);
          return;
        }

        this.rebuildConnectProps();
      }

      /**
       * Wires dispatch props and, if needed, a state subscription; then calls the base class `onMount`.
       *
       * @returns {void | Promise<void>} synchronously or a Promise if the superclass `onMount` is async
       */
      public override onMount (): void | Promise<void> {
        // Remount on the same instance must restart the first-pass / kick-off state machine.
        // PR #59 reset only `__connectTornDown`; leaving `__connectFirstPass` false skipped
        // user `onMount` and froze store→props delivery (`__connectMountCompleted` never set).
        this.__connectTornDown = false;
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

        const superOnMount = (Constructor.prototype as Record<string, unknown>)['onMount'];
        const hasSuperOnMount = typeof superOnMount === 'function';

        if (mapStateToProps == null) {
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

        let pendingMountResult: void | Promise<void> | null = null;
        // A sync throw in super.onMount on the first pass happens before
        // this.__connectSubscription is assigned (subscribe has not yet returned a Subscription) —
        // store the error and dispose after assignment, without rethrowing inside RxJS next.
        let syncFirstPassError: unknown = null;
        // Selector / mapStateToProps throw during subscribe (first BehaviorSubject emission)
        // or before mount completes: surface as onMount failure instead of a zombie ACTIVE tree.
        let syncSubscribeError: unknown = null;

        const selector = (state: S): R => mapStateToProps(
          state,
          this.__connectOwnProps as unknown as P
        );

        this.__connectSubscription = store.select(selector).subscribe({
          next: (mapped: R) => {
            this.applyMappedStateProps(mapped);

            if (this.__connectFirstPass) {
              this.__connectFirstPass = false;

              if (!hasSuperOnMount) {
                this.completeConnectMount();
                return;
              }

              let mountResult: void | Promise<void>;
              try {
                mountResult = (superOnMount as () => void | Promise<void>).call(this);
              } catch (error) {
                syncFirstPassError = error;
                return;
              }

              if (!isPromiseLike(mountResult)) {
                // Nested store emit during sync super.onMount may have already errored the
                // subscription (mapState throw). Do not complete mount / deliver onUpdate
                // before the post-subscribe rethrow — that ordered onUpdate before failed cleanup.
                if (syncSubscribeError !== null) {
                  return;
                }
                this.completeConnectMount();
                return;
              }

              pendingMountResult = Promise.resolve(mountResult as Promise<void>).then(() => {
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
        });

        if (syncFirstPassError !== null) {
          this.disposeConnectSubscription();
          throw syncFirstPassError;
        }

        if (syncSubscribeError !== null) {
          this.disposeConnectSubscription();
          throw syncSubscribeError;
        }

        if (pendingMountResult !== null) {
          return pendingMountResult;
        }
      }

      /**
       * Unsubscribes from the store and delegates to the base class `onUnmount`.
       *
       * @returns {void | Promise<void>}
       */
      public override onUnmount (): void | Promise<void> {
        this.__connectTornDown = true;
        this.__connectPendingUpdate = false;
        // Cancels a pending post-mount kick-off (mapDispatch-only has no subscription to null out).
        this.__connectMountCompleted = false;
        this.disposeConnectSubscription();

        const superOnUnmount = (Constructor.prototype as Record<string, unknown>)['onUnmount'];
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

    return Connected as unknown as C;
  };
}

/**
 * Connects a component class to the store (class-based HOC): merge into `props` from state and/or dispatch.
 * Supports two forms:
 * - `connect(store, mapState?, mapDispatch?)` for a root connected component;
 * - `connect(mapState?, mapDispatch?)` for a child connected component that receives the store from context.
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
