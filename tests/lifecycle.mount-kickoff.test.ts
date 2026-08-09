/**
 * Regression tests: lifecycle without `setTimeout(() => this.setState({}), 0)` in consumers.
 *
 * Effectable contracts:
 * - GraphRuntime: setState in onMount is buffered and schedules reconcile after startup.
 * - connect: sync-path super.onMount replays a pending store update deferred during mount.
 * - Post-mount kick-off (connect + mapStateToProps): one deferred onUpdate via
 *   queueMicrotask after mount (cold start without setState in consumer onMount).
 * - setState still calls onUpdate synchronously (including during onMount).
 */

import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';
import type {
  DispatchMethod,
  VirtualServiceNode,
} from 'Effectable';

interface KickoffStoreState {
  status: string;
  version: number;
}

type KickoffAction =
  | { type: 'SET_STATUS'; payload: string }
  | { type: 'SET_VERSION'; payload: number };

/**
 * Test store reducer for mount/kick-off scenarios.
 *
 * @param {KickoffStoreState} state - current store state
 * @param {KickoffAction} action - test scenario action
 * @returns {KickoffStoreState} new store state
 */
function reducer (state: KickoffStoreState, action: KickoffAction): KickoffStoreState {
  switch (action.type) {
    case 'SET_STATUS': {
      return { ...state, status: action.payload };
    }

    case 'SET_VERSION': {
      return { ...state, version: action.payload };
    }

    default: {
      return state;
    }
  }
}

/**
 * Waits for the microtask queue and a macrotask tick: flushDirtyFibers in GraphRuntime
 * is started via queueMicrotask, so setImmediate ensures it has finished.
 *
 * @returns {Promise<void>} promise that resolves after setImmediate
 */
async function flushRuntimeTasks (): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/**
 * Waits for macrotask timers (to verify the setTimeout hack).
 *
 * @param {number} ms - wait delay in milliseconds
 * @returns {Promise<void>} promise that resolves after the timer
 */
async function waitTimers (ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

interface ChildProbeProps {
  tag: string;
  onChildMount: (tag: string) => void;
}

/**
 * Leaf component: reports its mount via a callback from props.
 */
class ChildProbe extends Component<object, ChildProbeProps> {
  public override onMount (): void {
    this.props.onChildMount(this.props.tag);
  }
}

describe('GraphRuntime: setState inside onMount', () => {
  interface SubtreeHostState {
    show: boolean;
  }

  interface SubtreeHostProps {
    onChildMount: (tag: string) => void;
  }

  test('documents current semantics: setState in onMount synchronously calls onUpdate before mount completes', async () => {
    const log: string[] = [];

    class OrderHost extends Component<SubtreeHostState, SubtreeHostProps> {
      constructor (props: SubtreeHostProps) {
        super(props, { show: false });
      }

      public override onMount (): void {
        log.push('mount:start');
        this.setState({ show: true });
        log.push('mount:end');
      }

      public override onUpdate (): void {
        log.push('update');
      }
    }

    const runtime = await GraphRuntime.mount(
      h(OrderHost, { onChildMount: (): void => undefined })
    );

    // onUpdate runs synchronously from setState while onMount is still on the stack.
    expect(log).toEqual(['mount:start', 'update', 'mount:end']);

    await runtime.unmount();
  });

  test('setState in onMount rebuilds the compose() subtree after mount without the setTimeout hack', async () => {
    const mountedChildren: string[] = [];

    class SubtreeKickHost extends Component<SubtreeHostState, SubtreeHostProps> {
      constructor (props: SubtreeHostProps) {
        super(props, { show: false });
      }

      public override onMount (): void {
        this.setState({ show: true });
      }

      public override compose (): VirtualServiceNode[] {
        if (!this.state.show) {
          return [];
        }

        return [
          h(ChildProbe, {
            tag: 'kick-child',
            onChildMount: this.props.onChildMount,
          }, 'kick-child'),
        ];
      }
    }

    const runtime = await GraphRuntime.mount(
      h(SubtreeKickHost, {
        onChildMount: (tag: string): void => {
          mountedChildren.push(tag);
        },
      })
    );
    await flushRuntimeTasks();

    // SCHEDULE_UPDATE_HOOK buffers setState in onMount;
    // after startup GraphRuntime schedules reconcile — the child is mounted.
    expect(mountedChildren).toEqual(['kick-child']);

    await runtime.unmount();
  });

  test('control scenario: a setTimeout empty setState after onMount still rebuilds the subtree', async () => {
    const mountedChildren: string[] = [];

    class HackReplicaHost extends Component<SubtreeHostState, SubtreeHostProps> {
      constructor (props: SubtreeHostProps) {
        super(props, { show: false });
      }

      public override onMount (): void {
        // Replica of the production hack: direct state update in mount...
        this.state = { ...this.state, show: true };
        // ...and an empty setState on the next tick, when the update hook is already injected.
        setTimeout(() => {
          this.setState({});
        }, 0);
      }

      public override compose (): VirtualServiceNode[] {
        if (!this.state.show) {
          return [];
        }

        return [
          h(ChildProbe, {
            tag: 'hack-child',
            onChildMount: this.props.onChildMount,
          }, 'hack-child'),
        ];
      }
    }

    const runtime = await GraphRuntime.mount(
      h(HackReplicaHost, {
        onChildMount: (tag: string): void => {
          mountedChildren.push(tag);
        },
      })
    );

    await waitTimers(15);
    await flushRuntimeTasks();

    expect(mountedChildren).toEqual(['hack-child']);

    await runtime.unmount();
  });
});

describe('connect + GraphRuntime: kick-off after mount with pre-populated store (hack model #1)', () => {
  interface EngineMappedProps {
    status?: string;
    onChildMount?: (tag: string) => void;
  }

  interface EngineKickState {
    engineReady: boolean;
  }

  test('onMount does setState (kick-off) — after mount completes the compose() subtree rebuilds without the setTimeout hack', async () => {
    const mountedChildren: string[] = [];
    const store = createStore<KickoffStoreState, KickoffAction>(reducer, {
      // All data is already in the store before mount (cold start -> project sync -> session -> engine mount).
      status: 'synced',
      version: 7,
    });

    class EngineKickComponent extends Component<EngineKickState, EngineMappedProps> {
      public readonly updateLog: string[] = [];

      constructor (props: EngineMappedProps) {
        super(props, { engineReady: false });
      }

      public override onMount (): void {
        this.setState({ engineReady: true });
      }

      public override onUpdate (): void {
        this.updateLog.push(`update:${String(this.state.engineReady)}:${this.props.status ?? 'unknown'}`);
      }

      public override compose (): VirtualServiceNode[] {
        const onChildMount = this.props.onChildMount;
        if (!this.state.engineReady || onChildMount === undefined) {
          return [];
        }

        return [
          h(ChildProbe, {
            tag: 'engine-child',
            onChildMount,
          }, 'engine-child'),
        ];
      }
    }

    const ConnectedEngine = connect<
      KickoffStoreState,
      EngineMappedProps,
      EngineMappedProps
    >(
      store,
      (state: KickoffStoreState): EngineMappedProps => ({
        status: state.status,
        onChildMount: (tag: string): void => {
          mountedChildren.push(tag);
        },
      })
    )(EngineKickComponent);

    const engineRef: { current: EngineKickComponent | null } = { current: null };
    const runtime = await GraphRuntime.mount(
      h(ConnectedEngine, {}, engineRef)
    );
    await flushRuntimeTasks();

    if (engineRef.current === null) {
      throw new Error('Engine ref was not attached');
    }

    // Green part today: mapped props available from mount, onUpdate called (synchronously from setState).
    expect(engineRef.current.props.status).toBe('synced');
    expect(engineRef.current.updateLog.length).toBeGreaterThanOrEqual(1);

    // Kick-off setState in onMount rebuilds the compose() subtree.
    expect(mountedChildren).toEqual(['engine-child']);

    await runtime.unmount();
  });

  test('cold start: kick-off onUpdate after mount comes from the library, consumer does NOT change (onMount without setState)', async () => {
    const store = createStore<KickoffStoreState, KickoffAction>(reducer, {
      // All data is already in the store before mount — no new emits after mount.
      status: 'synced',
      version: 7,
    });

    interface ColdStartState {
      projectId: string | null;
    }

    class ColdStartEngineComponent extends Component<ColdStartState, EngineMappedProps> {
      public readonly updateLog: string[] = [];

      constructor (props: EngineMappedProps) {
        super(props, { projectId: null });
      }

      public override onMount (): void {
        // Direct state mutation WITHOUT setState. The consumer does not call setState —
        // the library must deliver post-mount kick-off.
        this.state = { ...this.state, projectId: 'project-1' };
      }

      public override onUpdate (): void {
        this.updateLog.push(`update:${this.state.projectId ?? 'null'}:${this.props.status ?? 'unknown'}`);
      }
    }

    const ConnectedColdStart = connect<
      KickoffStoreState,
      EngineMappedProps,
      EngineMappedProps
    >(
      store,
      (state: KickoffStoreState): EngineMappedProps => ({ status: state.status })
    )(ColdStartEngineComponent);

    const engineRef: { current: ColdStartEngineComponent | null } = { current: null };
    const runtime = await GraphRuntime.mount(
      h(ConnectedColdStart, {}, engineRef)
    );
    await flushRuntimeTasks();

    if (engineRef.current === null) {
      throw new Error('Engine ref was not attached');
    }

    // Post-mount kick-off from connect: exactly one deferred onUpdate after mount
    // without setState/setTimeout in the consumer (hack model #1 / handleInitProjectId).
    expect(engineRef.current.updateLog).toEqual(['update:project-1:synced']);

    await runtime.unmount();
  });

  test('store emit after mount: post-mount kick-off exactly once, then exactly one onUpdate per dispatch', async () => {
    const store = createStore<KickoffStoreState, KickoffAction>(reducer, {
      status: 'idle',
      version: 0,
    });

    class QuietEngineComponent extends Component<object, Partial<Pick<KickoffStoreState, 'status'>>> {
      public updatePasses = 0;

      public override onUpdate (): void {
        this.updatePasses += 1;
      }
    }

    const ConnectedQuietEngine = connect<
      KickoffStoreState,
      Partial<Pick<KickoffStoreState, 'status'>>,
      Pick<KickoffStoreState, 'status'>
    >(
      store,
      (state: KickoffStoreState): Pick<KickoffStoreState, 'status'> => ({ status: state.status })
    )(QuietEngineComponent);

    const engineRef: { current: QuietEngineComponent | null } = { current: null };
    const runtime = await GraphRuntime.mount(
      h(ConnectedQuietEngine, {}, engineRef)
    );
    await flushRuntimeTasks();

    if (engineRef.current === null) {
      throw new Error('Engine ref was not attached');
    }

    // Post-mount kick-off: exactly one onUpdate after mount.
    expect(engineRef.current.updatePasses).toBe(1);

    store.dispatch({ type: 'SET_STATUS', payload: 'running' });
    await flushRuntimeTasks();

    // Kick-off is not duplicated: exactly one extra pass per dispatch.
    expect(engineRef.current.updatePasses).toBe(2);

    await runtime.unmount();
  });
});

describe('connect: store emit during synchronous super.onMount', () => {
  interface DispatchMountProps {
    version?: number;
    bumpVersion?: (n: number) => void;
  }

  class DispatchInMountComponent extends Component<object, DispatchMountProps> {
    public readonly updateEvents: string[] = [];

    public override onMount (): void {
      const bumpVersion = this.props.bumpVersion;
      if (bumpVersion === undefined) {
        throw new Error('bumpVersion is not mapped');
      }

      // Synchronous dispatch inside mount: nested store emit before super.onMount completes.
      bumpVersion(1);
    }

    public override onUpdate (): void {
      this.updateEvents.push(`update:${String(this.props.version ?? -1)}`);
    }
  }

  test('nested emit during sync onMount is replayed as onUpdate after mount completes (pendingUpdate is not lost)', () => {
    const store = createStore<KickoffStoreState, KickoffAction>(reducer, {
      status: 'idle',
      version: 0,
    });

    const Connected = connect<
      KickoffStoreState,
      DispatchMountProps,
      Pick<DispatchMountProps, 'version'>
    >(
      store,
      (state: KickoffStoreState): Pick<DispatchMountProps, 'version'> => ({ version: state.version }),
      (dispatch: DispatchMethod<KickoffAction>): Pick<DispatchMountProps, 'bumpVersion'> => ({
        bumpVersion: (n: number): void => {
          dispatch({ type: 'SET_VERSION', payload: n });
        },
      })
    )(DispatchInMountComponent);

    const instance = new Connected({}) as DispatchInMountComponent;
    instance.onMount?.();

    // Green part today: props reflect state after the nested dispatch.
    expect(instance.props.version).toBe(1);

    // Sync onMount path replays __connectPendingUpdate → onUpdate.
    expect(instance.updateEvents).toEqual(['update:1']);

    instance.onUnmount?.();
  });
});

describe('setState inside onUpdate: next pass without the setTimeout hack (hack model #2)', () => {
  interface SessionMappedProps {
    status?: string;
  }

  interface SessionSwitchState {
    currentSessionId: string | null;
  }

  test('setState in onUpdate synchronously yields the next onUpdate pass with new state — a second tick is not required', async () => {
    const store = createStore<KickoffStoreState, KickoffAction>(reducer, {
      status: 'none',
      version: 0,
    });

    class SessionSwitchComponent extends Component<SessionSwitchState, SessionMappedProps> {
      public readonly passes: string[] = [];

      constructor (props: SessionMappedProps) {
        super(props, { currentSessionId: null });
      }

      public override onUpdate (): void {
        const incomingSessionId = this.props.status ?? null;
        this.passes.push(`pass:${this.state.currentSessionId ?? 'null'}->${incomingSessionId ?? 'null'}`);

        // Model a prop-driven identity change in onUpdate:
        // set a new sessionId and expect the next pass.
        if (incomingSessionId !== null && this.state.currentSessionId !== incomingSessionId) {
          this.setState({ currentSessionId: incomingSessionId });
          return;
        }

        if (incomingSessionId !== null) {
          this.passes.push(`ready:${incomingSessionId}`);
        }
      }
    }

    const Connected = connect<
      KickoffStoreState,
      SessionMappedProps,
      SessionMappedProps
    >(
      store,
      (state: KickoffStoreState): SessionMappedProps => {
        if (state.status === 'none') {
          return {};
        }

        return { status: state.status };
      }
    )(SessionSwitchComponent);

    const instance = new Connected({}) as SessionSwitchComponent;
    instance.onMount?.();

    expect(instance.passes).toEqual([]);

    store.dispatch({ type: 'SET_STATUS', payload: 'session-1' });

    // Pass 1: session mismatch -> setState; pass 2 happens synchronously (re-entrant)
    // and finishes the scenario — so setTimeout hack #2 is redundant under current setState semantics.
    expect(instance.passes).toEqual([
      'pass:null->session-1',
      'pass:session-1->session-1',
      'ready:session-1',
    ]);

    await flushRuntimeTasks();

    // No extra deferred passes appear.
    expect(instance.passes).toHaveLength(3);

    instance.onUnmount?.();
  });
});
