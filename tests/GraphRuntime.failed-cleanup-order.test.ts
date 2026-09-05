/**
 * Regression: failed materialization / update cleanup must honor children → parent
 * onUnmount order, and must not call parent onUnmount when parent onMount never ran.
 */
import { Component, GraphRuntime, h } from '../src/index';

describe('GraphRuntime failed-cleanup order', () => {
  it('child onMount fail does not call parent onUnmount when parent onMount never ran', async () => {
    const calls: string[] = [];

    class Child extends Component {
      public override onMount (): void {
        calls.push('child:onMount');
        throw new Error('child boom');
      }

      public override onUnmount (): void {
        calls.push('child:onUnmount');
      }
    }

    class Parent extends Component {
      public override onMount (): void {
        calls.push('parent:onMount');
      }

      public override onUnmount (): void {
        calls.push('parent:onUnmount');
      }

      public override compose () {
        return [h(Child, {})];
      }
    }

    await expect(GraphRuntime.mount(h(Parent, {}))).rejects.toThrow('child boom');
    expect(calls).toEqual(['child:onMount', 'child:onUnmount']);
  });

  it('parent onMount fail: child onUnmount runs before parent onUnmount', async () => {
    const calls: string[] = [];

    class Child extends Component {
      public override onMount (): void {
        calls.push('child:onMount');
      }

      public override onUnmount (): void {
        calls.push('child:onUnmount');
      }
    }

    class Parent extends Component {
      public override onMount (): void {
        calls.push('parent:onMount');
        throw new Error('parent boom');
      }

      public override onUnmount (): void {
        calls.push('parent:onUnmount');
      }

      public override compose () {
        return [h(Child, {})];
      }
    }

    await expect(GraphRuntime.mount(h(Parent, {}))).rejects.toThrow('parent boom');
    expect(calls).toEqual([
      'child:onMount',
      'parent:onMount',
      'child:onUnmount',
      'parent:onUnmount',
    ]);
  });

  it('onUpdate throw during reconcile: child onUnmount before parent onUnmount', async () => {
    const calls: string[] = [];

    class Child extends Component<Record<string, never>, { id: number }> {
      public override onMount (): void {
        calls.push('child:onMount');
      }

      public override onUnmount (): void {
        calls.push('child:onUnmount');
      }
    }

    class Parent extends Component<Record<string, never>, { boom: boolean }> {
      public override onMount (): void {
        calls.push('parent:onMount');
      }

      public override onUpdate (): void {
        if (this.props.boom) {
          calls.push('parent:onUpdate');
          throw new Error('update boom');
        }
      }

      public override onUnmount (): void {
        calls.push('parent:onUnmount');
      }

      public override compose () {
        return [h(Child, { id: this.props.boom ? 2 : 1 })];
      }
    }

    const rt = await GraphRuntime.mount(h(Parent, { boom: false }));
    expect(calls).toEqual(['child:onMount', 'parent:onMount']);

    await expect(rt.reconcile(h(Parent, { boom: true }))).rejects.toThrow('update boom');

    const childUn = calls.indexOf('child:onUnmount');
    const parentUn = calls.indexOf('parent:onUnmount');
    expect(childUn).toBeGreaterThanOrEqual(0);
    expect(parentUn).toBeGreaterThanOrEqual(0);
    expect(childUn).toBeLessThan(parentUn);
  });

  it('compose throw after pre-mount hook clears SCHEDULE_UPDATE_HOOK via rollback', async () => {
    const { SCHEDULE_UPDATE_HOOK } = await import('../src/component/types');

    class BoomCompose extends Component {
      public override compose (): never {
        throw new Error('compose boom');
      }
    }

    let instance: BoomCompose | null = null;
    const Original = BoomCompose;
    class Capture extends Original {
      constructor (props: Record<string, never>) {
        super(props);
        instance = this;
      }
    }

    await expect(GraphRuntime.mount(h(Capture, {}))).rejects.toThrow('compose boom');
    expect(instance).not.toBeNull();
    expect(
      (instance as unknown as Record<symbol, unknown>)[SCHEDULE_UPDATE_HOOK]
    ).toBeUndefined();
  });
});
