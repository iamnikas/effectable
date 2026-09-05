/**
 * Regression: setState must invoke SCHEDULE_UPDATE_HOOK even when onUpdate throws,
 * so GraphRuntime still reconciles children after a committed state write.
 *
 * @module Effectable/component/Component.setState-onUpdate-schedule.test
 */

import { Component, GraphRuntime, h } from 'Effectable';
import type { RefObject } from 'Effectable';

class Child extends Component<Record<string, never>, { n: number }> {
  public composeCount = 0;

  constructor (props: { n: number }) {
    super(props);
    this.state = {};
  }

  public override compose (): null {
    this.composeCount += 1;
    return null;
  }
}

class Parent extends Component<{ child: number }, Record<string, never>> {
  public childRef: RefObject<Child> = { current: null };

  constructor () {
    super({});
    this.state = { child: 1 };
  }

  public override onUpdate (): void {
    throw new Error('boom');
  }

  public override compose () {
    return h(Child, { n: this.state.child }, this.childRef);
  }
}

describe('Component.setState onUpdate throw still schedules GraphRuntime update', () => {
  it('reconciles child props after onUpdate throws', async () => {
    const runtime = await GraphRuntime.mount(h(Parent));
    const parent = runtime.getRootInstance() as Parent;
    const child = parent.childRef.current;
    expect(child).not.toBeNull();
    const before = child!.composeCount;
    expect(child!.props.n).toBe(1);

    expect(() => parent.setState({ child: 99 })).toThrow('boom');
    expect(parent.state.child).toBe(99);

    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    const childAfter = parent.childRef.current;
    expect(childAfter).not.toBeNull();
    expect(childAfter!.composeCount).toBeGreaterThan(before);
    expect(childAfter!.props.n).toBe(99);

    await runtime.unmount();
  });
});
