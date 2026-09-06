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

describe('Component single writer (state)', () => {
  async function closeConstructorStateGate (): Promise<void> {
    await Promise.resolve();
  }

  it('warns on direct this.state = after construction and leaves state unchanged', async () => {
    class Probe extends Component<{ n: number }, Record<string, never>> {
      constructor () {
        super({});
        this.state = { n: 0 };
      }
    }

    const c = new Probe();
    await closeConstructorStateGate();

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      c.state = { n: 7 };
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0]?.[0]).toEqual(
        expect.stringContaining('direct assignment to `state` is not supported'),
      );
      expect(warnSpy.mock.calls[0]?.[0]).toEqual(expect.stringContaining('setState'));
      expect(warnSpy.mock.calls[0]?.[0]).toEqual(expect.stringContaining('ref'));
      // Illicit assignment must not mutate state.
      expect(c.state.n).toBe(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('constructor this.state = and super(props, initial) do not warn', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      class ViaCtorAssign extends Component<{ n: number }, Record<string, never>> {
        constructor () {
          super({});
          this.state = { n: 1 };
        }
      }

      class ViaSuperInitial extends Component<{ n: number }, Record<string, never>> {
        constructor () {
          super({}, { n: 2 });
        }
      }

      const a = new ViaCtorAssign();
      const b = new ViaSuperInitial();
      expect(a.state.n).toBe(1);
      expect(b.state.n).toBe(2);
      expect(warnSpy).not.toHaveBeenCalled();
      await closeConstructorStateGate();
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('setState does not warn and still calls onUpdate + SCHEDULE_UPDATE_HOOK', async () => {
    class Hooked extends Component<{ n: number }, Record<string, never>> {
      public updates: Array<{ prev: number; next: number }> = [];

      constructor () {
        super({});
        this.state = { n: 0 };
      }

      public override onUpdate (prev: { n: number }, next: { n: number }): void {
        this.updates.push({ prev: prev.n, next: next.n });
      }
    }

    const c = new Hooked();
    await closeConstructorStateGate();

    let hookCalls = 0;
    (c as unknown as Record<symbol, unknown>)[SCHEDULE_UPDATE_HOOK] = (): void => {
      hookCalls += 1;
    };

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      c.setState({ n: 3 });
      expect(warnSpy).not.toHaveBeenCalled();
      expect(c.state.n).toBe(3);
      expect(c.updates).toEqual([{ prev: 0, next: 3 }]);
      expect(hookCalls).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('mutableState setState path does not warn and still calls onUpdate + schedule hook', async () => {
    class Mutable extends Component<{ n: number }, Record<string, never>> {
      public static override readonly mutableState = true;

      public updates: Array<{ sameRef: boolean; n: number }> = [];

      constructor () {
        super({});
        this.state = { n: 0 };
      }

      public override onUpdate (prev: { n: number }, next: { n: number }): void {
        this.updates.push({ sameRef: prev === next, n: next.n });
      }
    }

    const c = new Mutable();
    await closeConstructorStateGate();
    const before = c.state;

    let hookCalls = 0;
    (c as unknown as Record<symbol, unknown>)[SCHEDULE_UPDATE_HOOK] = (): void => {
      hookCalls += 1;
    };

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      c.setState({ n: 9 });
      expect(warnSpy).not.toHaveBeenCalled();
      expect(c.state).toBe(before);
      expect(c.state.n).toBe(9);
      expect(c.updates).toEqual([{ sameRef: true, n: 9 }]);
      expect(hookCalls).toBe(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('setState updates this.state when subclass class-field shadows the accessor', async () => {
    class FieldInit extends Component<{ n: number }, Record<string, never>> {
      public updates: number[] = [];

      constructor () {
        super({});
        // Same as `state = { n: 0 }` after super(): own data property shadows accessors.
        Object.defineProperty(this, 'state', {
          value: { n: 0 },
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }

      public override onUpdate (_prev: { n: number }, next: { n: number }): void {
        this.updates.push(next.n);
      }
    }

    const c = new FieldInit();
    await closeConstructorStateGate();
    expect(c.state.n).toBe(0);

    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      c.setState({ n: 5 });
      expect(warnSpy).not.toHaveBeenCalled();
      expect(c.state.n).toBe(5);
      expect(c.updates).toEqual([5]);

      c.setState((s) => ({ n: s.n + 1 }));
      expect(c.state.n).toBe(6);
      expect(c.updates).toEqual([5, 6]);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('mutableState setState updates class-field shadowed state in place', async () => {
    class FieldMutable extends Component<{ n: number }, Record<string, never>> {
      public static override readonly mutableState = true;

      constructor () {
        super({});
        Object.defineProperty(this, 'state', {
          value: { n: 0 },
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }

    const c = new FieldMutable();
    await closeConstructorStateGate();
    const before = c.state;
    c.setState({ n: 4 });
    expect(c.state).toBe(before);
    expect(c.state.n).toBe(4);
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
