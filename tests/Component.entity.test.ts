/**
 * Standalone behavior of the base Component class (without GraphRuntime).
 *
 * @module Effectable/component/Component.entity.test
 */

import { Component, GraphRuntime, h } from 'Effectable';
import type { RefObject } from 'Effectable';
import { SCHEDULE_UPDATE_HOOK } from 'Effectable/component/types';

interface S {
  count: number;
  extra?: string;
}

interface P {
  label: string;
}

class Stateful extends Component<S, P> {
  public updateLog: Array<{ prev: S; next: S }> = [];

  constructor (props: P, initial?: S) {
    super(props);
    this.state = initial ?? { count: 0 };
  }

  public override onUpdate (prev: S, next: S): void {
    this.updateLog.push({ prev: { ...prev }, next: { ...next } });
  }
}

describe('Component standalone', () => {
  it('initializes state as an empty object if initialState is not passed', () => {
    class NoInitial extends Component<Record<string, unknown>, Record<string, unknown>> {
      constructor () {
        super({});
      }
    }

    const c = new NoInitial();
    expect(c.state).toEqual({});
  });

  it('setState with object merges fields and calls onUpdate', () => {
    const c = new Stateful({ label: 'a' });

    c.setState({ count: 1 });

    expect(c.state.count).toBe(1);
    expect(c.updateLog).toHaveLength(1);
    expect(c.updateLog[0]?.prev.count).toBe(0);
    expect(c.updateLog[0]?.next.count).toBe(1);
  });

  it('setState with function receives prev and props and calls onUpdate', () => {
    const c = new Stateful({ label: 'x' });

    c.setState((prev, props) => {
      expect(props.label).toBe('x');
      return { count: prev.count + 5 };
    });

    expect(c.state.count).toBe(5);
    expect(c.updateLog).toHaveLength(1);
  });

  it('sequential setState calls accumulate changes', () => {
    const c = new Stateful({ label: 'y' });
    c.setState({ count: 1 });
    c.setState({ count: 2 });

    expect(c.state.count).toBe(2);
    expect(c.updateLog).toHaveLength(2);
  });

  it('setState without onUpdate override does not throw', () => {
    class Silent extends Component<{ n: number }, Record<string, unknown>> {
      constructor () {
        super({});
        this.state = { n: 0 };
      }
    }

    const c = new Silent();

    expect(() => {
      c.setState({ n: 1 });
    }).not.toThrow();

    expect(c.state.n).toBe(1);
  });

  it('setState with function merges partial result with previous state', () => {
    const c = new Stateful({ label: 'z' }, { count: 5, extra: 'keep' });

    c.setState(() => ({ count: 0 }));

    expect(c.state.count).toBe(0);
    expect(c.state.extra).toBe('keep');
    expect(c.updateLog).toHaveLength(1);
    expect(c.updateLog[0]?.next.count).toBe(0);
    expect(c.updateLog[0]?.next.extra).toBe('keep');
  });

  it('F07: setState inside onUpdate synchronously calls nested onUpdate (standalone)', () => {
    class NestedUpdate extends Component<{ n: number }, Record<string, unknown>> {
      public onUpdateCalls = 0;

      constructor () {
        super({});
        this.state = { n: 0 };
      }

      public override onUpdate (_prev: { n: number }, next: { n: number }): void {
        this.onUpdateCalls = this.onUpdateCalls + 1;
        if (next.n < 2) {
          this.setState({ n: next.n + 1 });
        }
      }
    }

    const c = new NestedUpdate();
    c.setState({ n: 0 });

    expect(c.state.n).toBe(2);
    expect(c.onUpdateCalls).toBe(3);
  });

  it('F08: after onUnmount standalone setState does not throw (Component has no unmount API)', async () => {
    class WithUnmountHook extends Component<{ v: number }, Record<string, unknown>> {
      public unmounted = false;

      constructor () {
        super({});
        this.state = { v: 0 };
      }

      public override async onUnmount (): Promise<void> {
        this.unmounted = true;
      }
    }

    const c = new WithUnmountHook();
    await c.onUnmount?.();

    expect(c.unmounted).toBe(true);

    expect(() => {
      c.setState({ v: 1 });
    }).not.toThrow();

    expect(c.state.v).toBe(1);
  });

  it('mutableState=true — in-place merge, onUpdate(prev, prev) with same reference', () => {
    class MutableTicker extends Component<{ n: number; tag?: string }, Record<string, unknown>> {
      public static override readonly mutableState = true;

      public updateLog: Array<{ sameRef: boolean; n: number }> = [];

      constructor () {
        super({});
        this.state = { n: 0 };
      }

      public override onUpdate (prev: { n: number }, next: { n: number }): void {
        this.updateLog.push({ sameRef: prev === next, n: next.n });
      }
    }

    const c = new MutableTicker();
    const stateBefore = c.state;

    c.setState({ n: 1, tag: 'x' });

    expect(c.state).toBe(stateBefore);
    expect(c.state.n).toBe(1);
    expect(c.state.tag).toBe('x');
    expect(c.updateLog).toHaveLength(1);
    expect(c.updateLog[0]?.sameRef).toBe(true);
    expect(c.updateLog[0]?.n).toBe(1);
  });

  it('mutableState=true — setState with function merges in-place, onUpdate(prev, prev)', () => {
    class MutableFn extends Component<{ n: number; tag?: string }, Record<string, unknown>> {
      public static override readonly mutableState = true;

      public updateLog: Array<{ sameRef: boolean; n: number; tag?: string }> = [];

      constructor () {
        super({});
        this.state = { n: 0, tag: 'keep' };
      }

      public override onUpdate (prev: { n: number; tag?: string }, next: { n: number; tag?: string }): void {
        this.updateLog.push({ sameRef: prev === next, n: next.n, tag: next.tag });
      }
    }

    const c = new MutableFn();
    const stateBefore = c.state;

    c.setState((prev) => ({ n: prev.n + 2 }));

    expect(c.state).toBe(stateBefore);
    expect(c.state.n).toBe(2);
    expect(c.state.tag).toBe('keep');
    expect(c.updateLog).toHaveLength(1);
    expect(c.updateLog[0]?.sameRef).toBe(true);
    expect(c.updateLog[0]?.n).toBe(2);
  });

  it('setState({}) with no field changes still calls onUpdate', () => {
    const c = new Stateful({ label: 'noop' }, { count: 3 });
    c.updateLog = [];

    c.setState({});

    expect(c.state.count).toBe(3);
    expect(c.updateLog).toHaveLength(1);
    expect(c.updateLog[0]?.prev.count).toBe(3);
    expect(c.updateLog[0]?.next.count).toBe(3);
  });

  it('SCHEDULE_UPDATE_HOOK is called after setState when the hook is set', () => {
    class Hooked extends Component<{ n: number }, Record<string, unknown>> {
      constructor () {
        super({});
        this.state = { n: 0 };
      }

      public override onUpdate (): void {}
    }

    const c = new Hooked();
    let hookCalls = 0;
    (c as unknown as Record<symbol, unknown>)[SCHEDULE_UPDATE_HOOK] = (): void => {
      hookCalls += 1;
    };

    c.setState({ n: 1 });

    expect(hookCalls).toBe(1);
    expect(c.state.n).toBe(1);
  });

  it('SCHEDULE_UPDATE_HOOK still runs when onUpdate throws after state commit', () => {
    class ThrowingUpdate extends Component<{ n: number }, Record<string, never>> {
      constructor () {
        super({});
        this.state = { n: 0 };
      }

      public override onUpdate (): void {
        throw new Error('boom');
      }
    }

    const c = new ThrowingUpdate();
    let hookCalls = 0;
    (c as unknown as Record<symbol, unknown>)[SCHEDULE_UPDATE_HOOK] = (): void => {
      hookCalls += 1;
    };

    expect(() => c.setState({ n: 99 })).toThrow('boom');
    expect(c.state.n).toBe(99);
    expect(hookCalls).toBe(1);
  });

  it('mutableState: SCHEDULE_UPDATE_HOOK still runs when onUpdate throws after in-place commit', () => {
    class ThrowingMutable extends Component<{ n: number }, Record<string, never>> {
      public static override readonly mutableState = true;

      constructor () {
        super({});
        this.state = { n: 0 };
      }

      public override onUpdate (): void {
        throw new Error('boom-mutable');
      }
    }

    const c = new ThrowingMutable();
    let hookCalls = 0;
    (c as unknown as Record<symbol, unknown>)[SCHEDULE_UPDATE_HOOK] = (): void => {
      hookCalls += 1;
    };

    expect(() => c.setState({ n: 7 })).toThrow('boom-mutable');
    expect(c.state.n).toBe(7);
    expect(hookCalls).toBe(1);
  });

  it('compose is optional — without override it is absent on the instance', () => {
    class NoComposeLeaf extends Component<Record<string, never>, { tag: string }> {
      constructor (props: { tag: string }) {
        super(props);
        this.state = {};
      }
    }

    const leaf = new NoComposeLeaf({ tag: 'x' });
    expect(typeof leaf.compose).toBe('undefined');
    expect(leaf.props.tag).toBe('x');
  });
});

describe('mount without compose()', () => {
  it('component without compose() override mounts via GraphRuntime with explicitChildren', async () => {
    class NoComposeHost extends Component<Record<string, unknown>, Record<string, unknown>> {
      constructor () {
        super({});
      }
    }

    class MountProbe extends Component<Record<string, unknown>, Record<string, unknown>> {
      public mounted = false;

      constructor () {
        super({});
      }

      public override async onMount (): Promise<void> {
        this.mounted = true;
      }
    }

    const childRef: RefObject<MountProbe> = { current: null };
    const runtime = await GraphRuntime.mount(
      h(NoComposeHost, {}, [h(MountProbe, {}, childRef)]),
    );

    expect(runtime.isActive()).toBe(true);
    expect(runtime.getRootInstance()).toBeInstanceOf(NoComposeHost);
    expect(childRef.current).not.toBeNull();
    if (childRef.current === null) {
      throw new Error('expected MountProbe via explicitChildren');
    }
    expect(childRef.current.mounted).toBe(true);

    await runtime.unmount();
    expect(childRef.current).toBeNull();
  });
});
