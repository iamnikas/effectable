/**
 * Benchmarks for `connect`: mount-path, update-path, nested context, and fan-out stress-path.
 * Run: npx jest connect.benchmark --testTimeout=120000
 */

import { benchAvgNs, coldVsWarm } from './helpers/effectableBenchmarkHelpers';
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';
import type { DispatchMethod, VirtualServiceNode } from 'Effectable';

const MOUNT_ITERATIONS = 20_000;
const UPDATE_ITERATIONS = 20_000;
const RECONCILE_ITERATIONS = 5_000;
const NESTED_MOUNT_ITERATIONS = 1_000;
const FAN_OUT_ITERATIONS = 5_000;
const FAN_OUT_SUBSCRIBERS = 64;
const MIN_STABLE_SELECTOR_SPEEDUP = 1.1;
const MAX_NESTED_CONTEXT_OVERHEAD_RATIO = 6;
const MAX_FAN_OUT_AMORTIZED_RATIO = 4;

interface BenchState {
  selected: number;
  other: number;
}

type BenchAction =
  | { type: 'INC_SELECTED' }
  | { type: 'INC_OTHER' };

interface BenchProps {
  id: string;
  selected?: number;
  incSelected?: () => void;
}

function reducer (state: BenchState, action: BenchAction): BenchState {
  switch (action.type) {
    case 'INC_SELECTED': {
      return {
        ...state,
        selected: state.selected + 1,
      };
    }

    case 'INC_OTHER': {
      return {
        ...state,
        other: state.other + 1,
      };
    }

    default: {
      return state;
    }
  }
}

function isPromiseLike (value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }

  const record = value as Record<PropertyKey, unknown>;
  return typeof record['then'] === 'function';
}

class BareComponent extends Component<Record<string, never>, BenchProps> {
  constructor (props: BenchProps) {
    super(props);
    this.state = {};
  }

  public override onMount (): void {}

  public override onUnmount (): void {}
}

class BenchmarkConnectedComponent extends Component<Record<string, never>, BenchProps> {
  public updates = 0;

  constructor (props: BenchProps) {
    super(props);
    this.state = {};
  }

  public override onMount (): void {}

  public override onUpdate (): void {
    this.updates += 1;
  }

  public override onUnmount (): void {}
}

interface FanOutBenchProps extends BenchProps {
  slot: number;
  onObservedUpdate: () => void;
}

/**
 * Component for the fan-out stress benchmark: counts every store update.
 *
 * @example
 * const instance = new FanOutBenchmarkConnectedComponent({
 *   id: 'node-1',
 *   slot: 0,
 *   onObservedUpdate: () => {}
 * });
 */
class FanOutBenchmarkConnectedComponent extends Component<Record<string, never>, FanOutBenchProps> {
  constructor (props: FanOutBenchProps) {
    super(props);
    this.state = {};
  }

  /**
   * Mounts the instance with no extra logic.
   * @returns {void}
   */
  public override onMount (): void {}

  /**
   * Increments an external counter so the benchmark can verify fan-out updates.
   * @returns {void}
   */
  public override onUpdate (): void {
    this.props.onObservedUpdate();
  }

  /**
   * Unmounts the instance with no extra logic.
   * @returns {void}
   */
  public override onUnmount (): void {}
}

interface NestedMountProps extends BenchProps {
  label: string;
}

/**
 * Leaf component for measuring nested connected mount-path via GraphRuntime.
 *
 * @example
 * const instance = new NestedMountLeafComponent({ id: 'leaf', label: 'flat' });
 */
class NestedMountLeafComponent extends Component<Record<string, never>, NestedMountProps> {
  constructor (props: NestedMountProps) {
    super(props);
    this.state = {};
  }

  /**
   * Mounts the leaf node of the benchmark scene.
   * @returns {void}
   */
  public override onMount (): void {}

  /**
   * Unmounts the leaf node of the benchmark scene.
   * @returns {void}
   */
  public override onUnmount (): void {}
}

/**
 * Flat host: one connected leaf under a root connected store provider.
 *
 * @example
 * const host = new NestedMountFlatHost({ id: 'flat', label: 'baseline' });
 */
class NestedMountFlatHost extends Component<Record<string, never>, NestedMountProps> {
  /**
   * Builds a flat tree for the baseline mount/unmount measurement.
   * @returns {VirtualServiceNode[]} nodes of the flat connected subtree
   */
  public override compose (): VirtualServiceNode[] {
    return [
      h(NestedFlatConnectedLeaf, {
        id: this.props.id,
        label: this.props.label,
      }),
    ];
  }
}

/**
 * Intermediate connected host for the nested benchmark scene.
 *
 * @example
 * const host = new NestedMountMiddleHost({ id: 'nested', label: 'middle' });
 */
class NestedMountMiddleHost extends Component<Record<string, never>, NestedMountProps> {
  /**
   * Adds a second connected level under the intermediate host.
   * @returns {VirtualServiceNode[]} nodes of the inner connected subtree
   */
  public override compose (): VirtualServiceNode[] {
    return [
      h(NestedContextConnectedLeaf, {
        id: this.props.id,
        label: this.props.label,
      }),
    ];
  }
}

/**
 * Root nested host: adds an extra connected layer before the leaf.
 *
 * @example
 * const host = new NestedMountRootHost({ id: 'nested-root', label: 'root' });
 */
class NestedMountRootHost extends Component<Record<string, never>, NestedMountProps> {
  /**
   * Builds a nested connected tree for measuring context/mount overhead.
   * @returns {VirtualServiceNode[]} root nodes of the nested benchmark scene
   */
  public override compose (): VirtualServiceNode[] {
    return [
      h(ConnectedNestedMiddleHost, {
        id: this.props.id,
        label: this.props.label,
      }),
    ];
  }
}

function runSyncMountCycle<TProps> (
  Constructor: new (props: TProps) => {
    onMount? (): void | Promise<void>;
    onUnmount? (): void | Promise<void>;
  },
  props: TProps,
): void {
  const instance = new Constructor(props);
  const mountResult = instance.onMount?.();
  if (isPromiseLike(mountResult)) {
    throw new Error('Benchmark expects synchronous onMount');
  }

  const unmountResult = instance.onUnmount?.();
  if (isPromiseLike(unmountResult)) {
    throw new Error('Benchmark expects synchronous onUnmount');
  }
}

function createStableSelectedSelector (): (state: BenchState) => Pick<BenchProps, 'selected'> {
  let previousSelected: number | null = null;
  let previousResult: Pick<BenchProps, 'selected'> = { selected: 0 };

  return function stableSelector (state: BenchState): Pick<BenchProps, 'selected'> {
    if (previousSelected === state.selected) {
      return previousResult;
    }

    previousSelected = state.selected;
    previousResult = { selected: state.selected };
    return previousResult;
  };
}

async function benchAvgAsyncNs (
  fn: () => Promise<void>,
  iterations: number,
  options?: { warmupIterations?: number },
): Promise<number> {
  const warmup = options?.warmupIterations ?? Math.min(500, Math.max(1, Math.floor(iterations / 10)));

  for (let i = 0; i < warmup; i++) {
    await fn();
  }

  const start = process.hrtime.bigint();

  for (let i = 0; i < iterations; i++) {
    await fn();
  }

  const end = process.hrtime.bigint();
  return Number(end - start) / iterations;
}

/**
 * Runs a full GraphRuntime mount/unmount cycle for the given tree.
 * @param {VirtualServiceNode} node - root node of the benchmark scene
 * @returns {Promise<void>} completion of the mount/unmount cycle
 */
async function runRuntimeMountCycle (node: VirtualServiceNode): Promise<void> {
  const runtime = await GraphRuntime.mount(node);
  await runtime.unmount();
}

const nestedMountStore = createStore<BenchState, BenchAction>(reducer, {
  selected: 0,
  other: 0,
});

const NestedFlatConnectedLeaf = connect(
  nestedMountStore,
  (state: BenchState): Pick<NestedMountProps, 'selected'> => ({
    selected: state.selected,
  })
)(NestedMountLeafComponent);

const NestedContextConnectedLeaf = connect<
  BenchState,
  NestedMountProps,
  Pick<NestedMountProps, 'selected'>,
  BenchAction
>(
  (state: BenchState): Pick<NestedMountProps, 'selected'> => ({
    selected: state.selected,
  })
)(NestedMountLeafComponent);

const ConnectedNestedMiddleHost = connect<
  BenchState,
  NestedMountProps,
  Pick<NestedMountProps, 'selected'>,
  BenchAction
>(
  (state: BenchState): Pick<NestedMountProps, 'selected'> => ({
    selected: state.selected,
  }),
  undefined,
  { ownPropsModeMerge: true }
)(NestedMountMiddleHost);

const ConnectedNestedFlatHost = connect(
  nestedMountStore,
  undefined,
  undefined,
  { ownPropsModeMerge: true }
)(NestedMountFlatHost);
const ConnectedNestedRootHost = connect(
  nestedMountStore,
  undefined,
  undefined,
  { ownPropsModeMerge: true }
)(NestedMountRootHost);

describe('Benchmark: connect mount-path', () => {
  it('compares raw component, dispatch-only connect, and state+dispatch connect', () => {
    console.log('\n=== connect mount-path ===');

    const rawNs = benchAvgNs(
      () => {
        runSyncMountCycle(BareComponent, { id: 'raw' });
      },
      MOUNT_ITERATIONS,
    );

    const dispatchStore = createStore<BenchState, BenchAction>(reducer, {
      selected: 0,
      other: 0,
    });
    const DispatchOnlyConnected = connect(
      dispatchStore,
      undefined,
      (dispatch: DispatchMethod<BenchAction>): Pick<BenchProps, 'incSelected'> => ({
        incSelected: (): void => {
          dispatch({ type: 'INC_SELECTED' });
        },
      })
    )(BenchmarkConnectedComponent);
    const dispatchNs = benchAvgNs(
      () => {
        runSyncMountCycle(DispatchOnlyConnected, { id: 'dispatch' });
      },
      MOUNT_ITERATIONS,
    );

    const stateStore = createStore<BenchState, BenchAction>(reducer, {
      selected: 0,
      other: 0,
    });
    const StateAndDispatchConnected = connect(
      stateStore,
      (state: BenchState): Pick<BenchProps, 'selected'> => ({
        selected: state.selected,
      }),
      (dispatch: DispatchMethod<BenchAction>): Pick<BenchProps, 'incSelected'> => ({
        incSelected: (): void => {
          dispatch({ type: 'INC_SELECTED' });
        },
      })
    )(BenchmarkConnectedComponent);
    const stateAndDispatchNs = benchAvgNs(
      () => {
        runSyncMountCycle(StateAndDispatchConnected, { id: 'state-dispatch' });
      },
      MOUNT_ITERATIONS,
    );

    console.log(`  raw mount/unmount: ${rawNs.toFixed(2)} ns/op`);
    console.log(`  connect(dispatch): ${dispatchNs.toFixed(2)} ns/op`);
    console.log(`  connect(state+dispatch): ${stateAndDispatchNs.toFixed(2)} ns/op`);
    console.log(`  overhead dispatch/raw: ${(dispatchNs / rawNs).toFixed(2)}x`);
    console.log(`  overhead state+dispatch/raw: ${(stateAndDispatchNs / rawNs).toFixed(2)}x`);

    expect(rawNs).toBeGreaterThan(0);
    expect(dispatchNs).toBeGreaterThan(0);
    expect(stateAndDispatchNs).toBeGreaterThan(0);
    expect(Number.isFinite(rawNs)).toBe(true);
    expect(Number.isFinite(dispatchNs)).toBe(true);
    expect(Number.isFinite(stateAndDispatchNs)).toBe(true);
  });
});

describe('Benchmark: connect selector fast-path', () => {
  it('stable selector is faster than allocating one on unrelated dispatch', () => {
    console.log('\n=== connect selector fast-path ===');

    const stableStore = createStore<BenchState, BenchAction>(reducer, {
      selected: 0,
      other: 0,
    });
    const stableSelector = createStableSelectedSelector();
    const StableConnected = connect(
      stableStore,
      stableSelector
    )(BenchmarkConnectedComponent);
    const stableInstance = new StableConnected({ id: 'stable-selector' });
    stableInstance.onMount();

    const stableWarmupIterations = 500;
    const stableNs = benchAvgNs(
      () => {
        stableStore.dispatch({ type: 'INC_OTHER' });
      },
      UPDATE_ITERATIONS,
      { warmupIterations: stableWarmupIterations },
    );

    const allocatingStore = createStore<BenchState, BenchAction>(reducer, {
      selected: 0,
      other: 0,
    });
    const AllocatingConnected = connect(
      allocatingStore,
      (state: BenchState): Pick<BenchProps, 'selected'> => ({
        selected: state.selected,
      })
    )(BenchmarkConnectedComponent);
    const allocatingInstance = new AllocatingConnected({ id: 'allocating-selector' });
    allocatingInstance.onMount();

    const allocatingWarmupIterations = 500;
    const allocatingNs = benchAvgNs(
      () => {
        allocatingStore.dispatch({ type: 'INC_OTHER' });
      },
      UPDATE_ITERATIONS,
      { warmupIterations: allocatingWarmupIterations },
    );

    const speedup = allocatingNs / stableNs;

    console.log(`  stable selector: ${stableNs.toFixed(2)} ns/op`);
    console.log(`  allocating selector: ${allocatingNs.toFixed(2)} ns/op`);
    console.log(`  speedup (allocating / stable): ${speedup.toFixed(2)}x`);

    expect(stableInstance.updates).toBe(0);
    expect(allocatingInstance.updates).toBe(
      UPDATE_ITERATIONS + allocatingWarmupIterations
    );
    expect(speedup).toBeGreaterThan(MIN_STABLE_SELECTOR_SPEEDUP);

    stableInstance.onUnmount();
    allocatingInstance.onUnmount();
  });

  it('prints cold vs warm for mount-path connect(state+dispatch)', () => {
    console.log('\n=== connect cold vs warm ===');

    const store = createStore<BenchState, BenchAction>(reducer, {
      selected: 0,
      other: 0,
    });
    const Connected = connect(
      store,
      (state: BenchState): Pick<BenchProps, 'selected'> => ({
        selected: state.selected,
      }),
      (dispatch: DispatchMethod<BenchAction>): Pick<BenchProps, 'incSelected'> => ({
        incSelected: (): void => {
          dispatch({ type: 'INC_SELECTED' });
        },
      })
    )(BenchmarkConnectedComponent);

    const result = coldVsWarm(
      () => {
        runSyncMountCycle(Connected, { id: 'cold-warm' });
      },
      5_000,
    );

    console.log(`  cold first call: ${result.coldNsPerOp.toFixed(0)} ns`);
    console.log(`  warm avg: ${result.warmNsPerOp.toFixed(2)} ns/op`);

    expect(result.coldNsPerOp).toBeGreaterThan(0);
    expect(result.warmNsPerOp).toBeGreaterThan(0);
    expect(Number.isFinite(result.coldNsPerOp)).toBe(true);
    expect(Number.isFinite(result.warmNsPerOp)).toBe(true);
  });

  it('prints changing selector update-path when selected actually changes', () => {
    console.log('\n=== connect changing selector update-path ===');

    const store = createStore<BenchState, BenchAction>(reducer, {
      selected: 0,
      other: 0,
    });
    const Connected = connect(
      store,
      (state: BenchState): Pick<BenchProps, 'selected'> => ({
        selected: state.selected,
      })
    )(BenchmarkConnectedComponent);
    const instance = new Connected({ id: 'changing-selector' });
    instance.onMount();

    const warmupIterations = 500;
    const changingNs = benchAvgNs(
      () => {
        store.dispatch({ type: 'INC_SELECTED' });
      },
      UPDATE_ITERATIONS,
      { warmupIterations }
    );

    console.log(`  changing selector path: ${changingNs.toFixed(2)} ns/op`);
    console.log(`  total updates observed: ${String(instance.updates)}`);

    expect(changingNs).toBeGreaterThan(0);
    expect(Number.isFinite(changingNs)).toBe(true);
    expect(instance.updates).toBe(UPDATE_ITERATIONS + warmupIterations);

    instance.onUnmount();
  });
});

describe('Benchmark: connect reconcile / props churn', () => {
  it('prints reconcile cost when a connected child props change often', async () => {
    console.log('\n=== connect reconcile / props churn ===');

    const store = createStore<BenchState, BenchAction>(reducer, {
      selected: 0,
      other: 0,
    });

    interface ReconcileBenchProps extends BenchProps {
      label: string;
      emitOwnId?: () => void;
    }

    class ReconcileBenchChild extends Component<Record<string, never>, ReconcileBenchProps> {
      constructor (props: ReconcileBenchProps) {
        super(props);
        this.state = {};
      }
    }

    const ConnectedChild = connect<
      BenchState,
      ReconcileBenchProps,
      Pick<ReconcileBenchProps, 'selected'>,
      BenchAction
    >(
      (state: BenchState): Pick<ReconcileBenchProps, 'selected'> => ({
        selected: state.selected,
      }),
      (
        dispatch: DispatchMethod<BenchAction>,
        props: ReconcileBenchProps
      ): Pick<ReconcileBenchProps, 'emitOwnId'> => ({
        emitOwnId: (): void => {
          if (props.id === 'selected') {
            dispatch({ type: 'INC_SELECTED' });
            return;
          }

          dispatch({ type: 'INC_OTHER' });
        },
      })
    )(ReconcileBenchChild);

    interface RootProps {
      childId: string;
      label: string;
    }

    class RootHost extends Component<Record<string, never>, RootProps> {
      public override compose (): VirtualServiceNode[] {
        return [
          h(ConnectedChild, {
            id: this.props.childId,
            label: this.props.label,
          }),
        ];
      }
    }

    const ConnectedRootHost = connect(
      store,
      undefined,
      undefined,
      { ownPropsModeMerge: true }
    )(RootHost);
    const runtime = await GraphRuntime.mount(
      h(ConnectedRootHost, { childId: 'initial', label: 'warmup' })
    );

    let toggle = false;
    const reconcileNs = await benchAvgAsyncNs(
      async () => {
        toggle = !toggle;
        await runtime.reconcile(
          h(ConnectedRootHost, {
            childId: toggle ? 'selected' : 'other',
            label: toggle ? 'A' : 'B',
          })
        );
      },
      RECONCILE_ITERATIONS,
      { warmupIterations: 200 }
    );

    console.log(`  reconcile props churn: ${reconcileNs.toFixed(2)} ns/op`);

    expect(reconcileNs).toBeGreaterThan(0);
    expect(Number.isFinite(reconcileNs)).toBe(true);

    await runtime.unmount();
  });
});

describe('Benchmark: connect nested context overhead', () => {
  it('prints nested connected subtree overhead against a flat baseline', async () => {
    console.log('\n=== connect nested context overhead ===');

    const flatNs = await benchAvgAsyncNs(
      async () => {
        await runRuntimeMountCycle(
          h(ConnectedNestedFlatHost, {
            id: 'flat',
            label: 'flat',
          })
        );
      },
      NESTED_MOUNT_ITERATIONS,
      { warmupIterations: 100 }
    );

    const nestedNs = await benchAvgAsyncNs(
      async () => {
        await runRuntimeMountCycle(
          h(ConnectedNestedRootHost, {
            id: 'nested',
            label: 'nested',
          })
        );
      },
      NESTED_MOUNT_ITERATIONS,
      { warmupIterations: 100 }
    );

    const nestedOverheadRatio = nestedNs / flatNs;

    console.log(`  flat connected subtree: ${flatNs.toFixed(2)} ns/op`);
    console.log(`  nested connected subtree: ${nestedNs.toFixed(2)} ns/op`);
    console.log(`  nested/flat ratio: ${nestedOverheadRatio.toFixed(2)}x`);

    expect(flatNs).toBeGreaterThan(0);
    expect(nestedNs).toBeGreaterThan(0);
    expect(Number.isFinite(flatNs)).toBe(true);
    expect(Number.isFinite(nestedNs)).toBe(true);
    expect(nestedOverheadRatio).toBeLessThan(MAX_NESTED_CONTEXT_OVERHEAD_RATIO);
  });
});

describe('Benchmark: connect fan-out stress', () => {
  it('prints dispatch cost under mass updates of many connected subscribers', () => {
    console.log('\n=== connect fan-out stress ===');

    const store = createStore<BenchState, BenchAction>(reducer, {
      selected: 0,
      other: 0,
    });
    const Connected = connect(
      store,
      (state: BenchState): Pick<FanOutBenchProps, 'selected'> => ({
        selected: state.selected,
      }),
      undefined,
      { ownPropsModeMerge: true }
    )(FanOutBenchmarkConnectedComponent);
    const SingleConnected = connect(
      store,
      (state: BenchState): Pick<FanOutBenchProps, 'selected'> => ({
        selected: state.selected,
      }),
      undefined,
      { ownPropsModeMerge: true }
    )(FanOutBenchmarkConnectedComponent);

    let singleObservedUpdates = 0;
    const singleInstance = new SingleConnected({
      id: 'fan-out-single',
      slot: -1,
      onObservedUpdate: (): void => {
        singleObservedUpdates += 1;
      },
    });
    singleInstance.onMount();

    const singleWarmupIterations = 200;
    const singleSubscriberNs = benchAvgNs(
      () => {
        store.dispatch({ type: 'INC_SELECTED' });
      },
      FAN_OUT_ITERATIONS,
      { warmupIterations: singleWarmupIterations }
    );

    singleInstance.onUnmount();

    let observedUpdates = 0;
    const instances = Array.from({ length: FAN_OUT_SUBSCRIBERS }, (_, index) => {
      return new Connected({
        id: `fan-out-${String(index)}`,
        slot: index,
        onObservedUpdate: (): void => {
          observedUpdates += 1;
        },
      });
    });

    for (const instance of instances) {
      instance.onMount();
    }

    const warmupIterations = 200;
    const fanOutNs = benchAvgNs(
      () => {
        store.dispatch({ type: 'INC_SELECTED' });
      },
      FAN_OUT_ITERATIONS,
      { warmupIterations }
    );
    const amortizedFanOutNs = fanOutNs / FAN_OUT_SUBSCRIBERS;
    const amortizedRatio = amortizedFanOutNs / singleSubscriberNs;

    console.log(`  single subscriber path: ${singleSubscriberNs.toFixed(2)} ns/op`);
    console.log(`  subscribers: ${String(FAN_OUT_SUBSCRIBERS)}`);
    console.log(`  dispatch fan-out path: ${fanOutNs.toFixed(2)} ns/op`);
    console.log(`  fan-out amortized per subscriber: ${amortizedFanOutNs.toFixed(2)} ns/op`);
    console.log(`  amortized/single ratio: ${amortizedRatio.toFixed(2)}x`);
    console.log(`  single observed updates: ${String(singleObservedUpdates)}`);
    console.log(`  observed updates: ${String(observedUpdates)}`);

    expect(singleSubscriberNs).toBeGreaterThan(0);
    expect(fanOutNs).toBeGreaterThan(0);
    expect(Number.isFinite(singleSubscriberNs)).toBe(true);
    expect(Number.isFinite(fanOutNs)).toBe(true);
    expect(singleObservedUpdates).toBe(FAN_OUT_ITERATIONS + singleWarmupIterations);
    expect(observedUpdates).toBe(
      (FAN_OUT_ITERATIONS + warmupIterations) * FAN_OUT_SUBSCRIBERS
    );
    expect(amortizedRatio).toBeLessThan(MAX_FAN_OUT_AMORTIZED_RATIO);

    for (const instance of instances) {
      instance.onUnmount();
    }
  });
});

jest.setTimeout(120_000);
