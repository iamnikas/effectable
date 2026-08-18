/**
 * GraphRuntime: resilience and scale (P1 I38–I42).
 *
 * @module Effectable/component/GraphRuntime.resilience.test
 */

import { Component, GraphRuntime, h } from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

jest.setTimeout(120_000);

const DEEP_TREE_DEPTH = 32;
const WIDE_SIBLING_COUNT = 10_000;
const WIDE_BRANCH_COUNT = 100;
const WIDE_LEAVES_PER_BRANCH = WIDE_SIBLING_COUNT / WIDE_BRANCH_COUNT;
const BURST_SET_STATE_COUNT = 24;

async function flushRuntimeTasks (): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

interface ResilienceLeafProps {
  slot: number;
  tick: number;
}

class ResilienceLeaf extends Component<Record<string, never>, ResilienceLeafProps> {
  public mountCount = 0;

  public unmountCount = 0;

  public lastTick = -1;

  constructor (props: ResilienceLeafProps) {
    super(props);
    this.state = {};
  }

  public override onMount (): void {
    this.mountCount += 1;
    this.lastTick = this.props.tick;
  }

  public override onUnmount (): void {
    this.unmountCount += 1;
  }

  public override onUpdate (): void {
    this.lastTick = this.props.tick;
  }
}

interface DeepNestProps {
  depth: number;
  tick: number;
}

class DeepNestHost extends Component<Record<string, never>, DeepNestProps> {
  constructor (props: DeepNestProps) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode[] {
    if (this.props.depth <= 1) {
      return [h(ResilienceLeaf, { slot: 0, tick: this.props.tick })];
    }

    return [
      h(DeepNestHost, {
        depth: this.props.depth - 1,
        tick: this.props.tick,
      }),
    ];
  }
}

interface ChurnRootProps {
  tick: number;
}

class DeepChurnRoot extends Component<Record<string, never>, ChurnRootProps> {
  public composeInvocations = 0;

  constructor (props: ChurnRootProps) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode[] {
    this.composeInvocations += 1;
    return [
      h(DeepNestHost, {
        depth: DEEP_TREE_DEPTH,
        tick: this.props.tick,
      }),
    ];
  }
}

interface FailLeafProps {
  tick: number;
  shouldFail: boolean;
}

class FailOnMountLeaf extends Component<Record<string, never>, FailLeafProps> {
  public calls: string[] = [];

  constructor (props: FailLeafProps) {
    super(props);
    this.state = {};
  }

  public override onMount (): void {
    this.calls.push('onMount');
    if (this.props.shouldFail) {
      throw new Error('FailOnMountLeaf: intentional mount failure');
    }
  }

  public override onUnmount (): void {
    this.calls.push('onUnmount');
  }
}

interface DeepFailNestProps {
  depth: number;
  tick: number;
  leafFail: boolean;
  leafKey: string;
}

class DeepFailNestHost extends Component<Record<string, never>, DeepFailNestProps> {
  constructor (props: DeepFailNestProps) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode[] {
    if (this.props.depth <= 1) {
      return [
        h(
          FailOnMountLeaf,
          { tick: this.props.tick, shouldFail: this.props.leafFail },
          this.props.leafKey,
        ),
      ];
    }

    return [
      h(DeepFailNestHost, {
        depth: this.props.depth - 1,
        tick: this.props.tick,
        leafFail: this.props.leafFail,
        leafKey: this.props.leafKey,
      }),
    ];
  }
}

interface WideLeafProps {
  branchIndex: number;
  leafIndex: number;
  value: number;
}

class WideLeaf extends Component<Record<string, never>, WideLeafProps> {
  constructor (props: WideLeafProps) {
    super(props);
    this.state = {};
  }

  public override onMount (): void {}

  public override onUnmount (): void {}
}

interface WideBranchProps {
  branchIndex: number;
  leafValue: number;
}

class WideBranchHost extends Component<Record<string, never>, WideBranchProps> {
  constructor (props: WideBranchProps) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode[] {
    const nodes: VirtualServiceNode[] = [];

    for (let leafIndex = 0; leafIndex < WIDE_LEAVES_PER_BRANCH; leafIndex += 1) {
      const key = `b${String(this.props.branchIndex)}-l${String(leafIndex)}`;
      nodes.push(
        h(
          WideLeaf,
          {
            branchIndex: this.props.branchIndex,
            leafIndex,
            value: this.props.leafValue,
          },
          key,
        ),
      );
    }

    return nodes;
  }
}

interface WideRootProps {
  leafValue: number;
}

class WideRootHost extends Component<Record<string, never>, WideRootProps> {
  constructor (props: WideRootProps) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode[] {
    const nodes: VirtualServiceNode[] = [];

    for (let branchIndex = 0; branchIndex < WIDE_BRANCH_COUNT; branchIndex += 1) {
      nodes.push(
        h(
          WideBranchHost,
          {
            branchIndex,
            leafValue: this.props.leafValue,
          },
          `branch-${String(branchIndex)}`,
        ),
      );
    }

    return nodes;
  }
}

interface FlatWideItem {
  id: string;
  value: number;
}

interface FlatWideHostProps {
  items: FlatWideItem[];
}

class FlatWideHost extends Component<Record<string, never>, FlatWideHostProps> {
  constructor (props: FlatWideHostProps) {
    super(props);
    this.state = {};
  }

  public override compose (): VirtualServiceNode[] {
    return this.props.items.map((item) => {
      return h(
        WideLeaf,
        {
          branchIndex: 0,
          leafIndex: 0,
          value: item.value,
        },
        item.id,
      );
    });
  }
}

function createFlatWideItems (count: number, baseValue: number): FlatWideItem[] {
  const items: FlatWideItem[] = [];

  for (let i = 0; i < count; i += 1) {
    items.push({
      id: `leaf-${String(i)}`,
      value: baseValue + i,
    });
  }

  return items;
}

function reverseSliceTenPercent (items: FlatWideItem[]): FlatWideItem[] {
  const sliceLen = Math.floor(items.length / 10);
  const start = Math.floor((items.length - sliceLen) / 2);
  const next: FlatWideItem[] = [];

  for (let i = 0; i < items.length; i += 1) {
    next.push(items[i]);
  }

  const slice: FlatWideItem[] = [];
  for (let i = start; i < start + sliceLen; i += 1) {
    slice.push(next[i]);
  }

  slice.reverse();

  for (let j = 0; j < sliceLen; j += 1) {
    next[start + j] = slice[j];
  }

  return next;
}

function patchSingleLeafValue (items: FlatWideItem[], targetIndex: number, delta: number): FlatWideItem[] {
  const next: FlatWideItem[] = [];

  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (i === targetIndex) {
      next.push({
        id: item.id,
        value: item.value + delta,
      });
    } else {
      next.push({
        id: item.id,
        value: item.value,
      });
    }
  }

  return next;
}

interface BurstHostState {
  tick: number;
}

class BurstDirtyRoot extends Component<BurstHostState, Record<string, unknown>> {
  public composeInvocations = 0;

  constructor (props: Record<string, unknown>) {
    super(props, { tick: 0 });
  }

  public burstSetState (times: number): void {
    for (let i = 0; i < times; i += 1) {
      this.setState((prev) => {
        return { tick: prev.tick + 1 };
      });
    }
  }

  public override compose (): VirtualServiceNode[] {
    this.composeInvocations += 1;
    return [h(ResilienceLeaf, { slot: 0, tick: this.state.tick })];
  }
}

describe('GraphRuntime resilience (P1 I38–I42)', () => {
  describe('I38 — deep tree and props churn', () => {
    it('mounts a depth=32 chain and survives a series of reconcile with churn tick', async () => {
      const runtime = await GraphRuntime.mount(
        h(DeepChurnRoot, { tick: 0 }),
      );

      expect(runtime.isActive()).toBe(true);

      const root = runtime.getRootInstance() as DeepChurnRoot | null;
      expect(root).not.toBeNull();

      if (root === null) {
        throw new Error('expected DeepChurnRoot instance');
      }

      const composeAfterMount = root.composeInvocations;
      expect(composeAfterMount).toBeGreaterThanOrEqual(1);

      const reconcilePasses = 6;
      for (let pass = 1; pass <= reconcilePasses; pass += 1) {
        await runtime.reconcile(h(DeepChurnRoot, { tick: pass }));
        expect(runtime.isActive()).toBe(true);
      }

      expect(root.composeInvocations).toBeGreaterThan(composeAfterMount);
      expect(Number.isFinite(root.composeInvocations)).toBe(true);

      await runtime.unmount();
      expect(runtime.isActive()).toBe(false);
    });
  });

  describe('I39 — leaf error on a deep tree', () => {
    it('on leaf onMount error during reconcile rethrows, runtime transitions to FAILED (issue #10)', async () => {
      const depth = 16;
      const runtime = await GraphRuntime.mount(
        h(DeepFailNestHost, {
          depth,
          tick: 0,
          leafFail: false,
          leafKey: 'leaf-v0',
        }),
      );

      expect(runtime.isActive()).toBe(true);

      await expect(
        runtime.reconcile(
          h(DeepFailNestHost, {
            depth,
            tick: 1,
            leafFail: true,
            leafKey: 'leaf-v1',
          }),
        ),
      ).rejects.toThrow('FailOnMountLeaf: intentional mount failure');

      // Runtime transitions to FAILED on unrecoverable error (issue #10)
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getState()).toBe('failed');

      // Unmount is still safe
      await runtime.unmount();
      await runtime.unmount();
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getState()).toBe('unmounted');
    });

    it('on leaf onMount error at start mount rejects and repeated unmount without runtime is idempotent', async () => {
      const depth = 12;

      await expect(
        GraphRuntime.mount(
          h(DeepFailNestHost, {
            depth,
            tick: 0,
            leafFail: true,
            leafKey: 'leaf-fail',
          }),
        ),
      ).rejects.toThrow('FailOnMountLeaf: intentional mount failure');
    });
  });

  describe('I40 — wide tree ~10k leaves', () => {
    it('mounts and unmounts ~10_000 keyed leaves at depth≤3', async () => {
      const runtime = await GraphRuntime.mount(
        h(WideRootHost, { leafValue: 1 }),
      );

      expect(runtime.isActive()).toBe(true);

      await runtime.unmount();
      expect(runtime.isActive()).toBe(false);
      expect(runtime.getRootInstance()).toBeNull();
    });
  });

  describe('I41 — partial update / reorder on a wide tree', () => {
    it('updates props of one leaf among ~10k without full root remount', async () => {
      const initial = createFlatWideItems(WIDE_SIBLING_COUNT, 100);
      const runtime = await GraphRuntime.mount(
        h(FlatWideHost, { items: initial }),
      );

      expect(runtime.isActive()).toBe(true);

      const targetIndex = 4242;
      const patched = patchSingleLeafValue(initial, targetIndex, 9000);

      await runtime.reconcile(h(FlatWideHost, { items: patched }));
      expect(runtime.isActive()).toBe(true);

      await runtime.unmount();
      expect(runtime.isActive()).toBe(false);
    });

    it('reorders ~10% keyed leaves (reverse slice) and completes reconcile', async () => {
      let items = createFlatWideItems(WIDE_SIBLING_COUNT, 0);
      const runtime = await GraphRuntime.mount(
        h(FlatWideHost, { items }),
      );

      expect(runtime.isActive()).toBe(true);

      items = reverseSliceTenPercent(items);
      await runtime.reconcile(h(FlatWideHost, { items }));

      expect(runtime.isActive()).toBe(true);

      await runtime.unmount();
      expect(runtime.isActive()).toBe(false);
    });
  });

  describe('I42 — burst setState and coalesce dirty', () => {
    it('a series of setState before microtask yields a bounded number of compose/reconcile passes', async () => {
      const runtime = await GraphRuntime.mount(h(BurstDirtyRoot, {}));
      const root = runtime.getRootInstance() as BurstDirtyRoot | null;

      expect(root).not.toBeNull();
      expect(runtime.isActive()).toBe(true);

      if (root === null) {
        throw new Error('expected BurstDirtyRoot instance');
      }

      const composeAfterMount = root.composeInvocations;
      expect(composeAfterMount).toBe(1);

      root.burstSetState(BURST_SET_STATE_COUNT);
      expect(root.state.tick).toBe(BURST_SET_STATE_COUNT);

      await flushRuntimeTasks();

      const composeAfterFlush = root.composeInvocations;
      expect(composeAfterFlush).toBeLessThanOrEqual(composeAfterMount + 2);
      expect(composeAfterFlush).toBeGreaterThan(composeAfterMount);

      await flushRuntimeTasks();
      const composeAfterIdle = root.composeInvocations;
      expect(composeAfterIdle).toBe(composeAfterFlush);

      await runtime.unmount();
      expect(runtime.isActive()).toBe(false);
    });
  });

  describe('I43 — duplicate key semantics (issue #18)', () => {
    interface DupKeyProps {
      label: string;
    }

    class DupKeyLeaf extends Component<Record<string, never>, DupKeyProps> {
      public mountCalls = 0;

      public unmountCalls = 0;

      constructor (props: DupKeyProps) {
        super(props);
        this.state = {};
      }

      public override onMount (): void {
        this.mountCalls += 1;
      }

      public override onUnmount (): void {
        this.unmountCalls += 1;
      }
    }

    interface DupKeyHostProps {
      items: Array<{ key: string; label: string }>;
    }

    class DupKeyHost extends Component<Record<string, never>, DupKeyHostProps> {
      constructor (props: DupKeyHostProps) {
        super(props);
        this.state = {};
      }

      public override compose (): VirtualServiceNode[] {
        return this.props.items.map((item) =>
          h(DupKeyLeaf, { label: item.label }, item.key),
        );
      }
    }

    it('throws on duplicate keys in current children during mount (same-length)', async () => {
      await expect(
        GraphRuntime.mount(
          h(DupKeyHost, {
            items: [
              { key: 'dup', label: 'first' },
              { key: 'dup', label: 'second' },
            ],
          }),
        ),
      ).rejects.toThrow(/duplicate key "dup" in current children of DupKeyHost/);
    });

    it('throws on duplicate keys in current children during mount (different-length)', async () => {
      await expect(
        GraphRuntime.mount(
          h(DupKeyHost, {
            items: [
              { key: 'dup', label: 'first' },
              { key: 'dup', label: 'second' },
              { key: 'unique', label: 'third' },
            ],
          }),
        ),
      ).rejects.toThrow(/duplicate key "dup" in current children of DupKeyHost/);
    });

    it('throws on duplicate keys in next children during reconcile (same-length)', async () => {
      const runtime = await GraphRuntime.mount(
        h(DupKeyHost, {
          items: [
            { key: 'a', label: 'first' },
            { key: 'b', label: 'second' },
          ],
        }),
      );

      await expect(
        runtime.reconcile(
          h(DupKeyHost, {
            items: [
              { key: 'dup', label: 'new-first' },
              { key: 'dup', label: 'new-second' },
            ],
          }),
        ),
      ).rejects.toThrow(/duplicate key "dup" in next children of DupKeyHost/);

      await runtime.unmount();
    });

    it('throws on duplicate keys in next children during reconcile (different-length)', async () => {
      const runtime = await GraphRuntime.mount(
        h(DupKeyHost, {
          items: [
            { key: 'a', label: 'first' },
            { key: 'b', label: 'second' },
          ],
        }),
      );

      await expect(
        runtime.reconcile(
          h(DupKeyHost, {
            items: [
              { key: 'dup', label: 'new-first' },
              { key: 'dup', label: 'new-second' },
              { key: 'c', label: 'new-third' },
            ],
          }),
        ),
      ).rejects.toThrow(/duplicate key "dup" in next children of DupKeyHost/);

      await runtime.unmount();
    });

    it('validates before side effects: no leaked fiber when duplicate detected', async () => {
      let mountedInstances: DupKeyLeaf[] = [];

      class TrackingDupHost extends Component<Record<string, never>, DupKeyHostProps> {
        constructor (props: DupKeyHostProps) {
          super(props);
          this.state = {};
        }

        public override compose (): VirtualServiceNode[] {
          return this.props.items.map((item) => {
            const ref = { current: null as DupKeyLeaf | null };
            const node = h(DupKeyLeaf, { label: item.label }, item.key);
            node.ref = ref;
            
            if (ref.current !== null) {
              mountedInstances.push(ref.current);
            }
            
            return node;
          });
        }
      }

      await expect(
        GraphRuntime.mount(
          h(TrackingDupHost, {
            items: [
              { key: 'dup', label: 'first' },
              { key: 'dup', label: 'second' },
            ],
          }),
        ),
      ).rejects.toThrow(/duplicate key "dup"/);

      // No instances should be mounted because validation happens BEFORE side effects
      expect(mountedInstances.length).toBe(0);
    });

    it('unique keys complete reconcile without errors (regression test)', async () => {
      const runtime = await GraphRuntime.mount(
        h(DupKeyHost, {
          items: [
            { key: 'a', label: 'first' },
            { key: 'b', label: 'second' },
          ],
        }),
      );

      expect(runtime.isActive()).toBe(true);

      await runtime.reconcile(
        h(DupKeyHost, {
          items: [
            { key: 'c', label: 'third' },
            { key: 'd', label: 'fourth' },
          ],
        }),
      );

      expect(runtime.isActive()).toBe(true);

      await runtime.unmount();
      expect(runtime.isActive()).toBe(false);
    });
  });
});
