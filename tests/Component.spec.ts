/**
 * Unit tests for Effectable.Component: state, setState, onUpdate.
 */
import { Component } from 'Effectable';

interface TestState {
  count: number;
  label?: string;
}

class TestComponent extends Component<TestState, { id: string }> {
  public updates: Array<{ prev: TestState; next: TestState }> = [];

  constructor (props: { id: string }, initial: TestState) {
    super(props);
    this.state = { ...initial };
  }

  public override onUpdate(prev: TestState, next: TestState): void {
    this.updates.push({ prev: { ...prev }, next: { ...next } });
  }
}

describe('Effectable.Component', () => {
  describe('setState', () => {
    test('merge partial state and call onUpdate', () => {
      const c = new TestComponent({ id: '1' }, { count: 0 });
      c.setState({ count: 1 });
      expect(c.state).toEqual({ count: 1 });
      expect(c.updates).toHaveLength(1);
      expect(c.updates[0].prev).toEqual({ count: 0 });
      expect(c.updates[0].next).toEqual({ count: 1 });
    });

    test('setState with function updater', () => {
      const c = new TestComponent({ id: '1' }, { count: 2 });
      c.setState((prev) => ({ count: prev.count + 1 }));
      expect(c.state).toEqual({ count: 3 });
      expect(c.updates[0].next).toEqual({ count: 3 });
    });

    test('multiple setState calls each trigger onUpdate', () => {
      const c = new TestComponent({ id: '1' }, { count: 0 });
      c.setState({ count: 1 });
      c.setState({ label: 'a' });
      expect(c.state).toEqual({ count: 1, label: 'a' });
      expect(c.updates).toHaveLength(2);
    });

    it('without onUpdate override setState does not throw', () => {
      class DefaultUpdate extends Component<{ v: number }, Record<string, unknown>> {
        constructor () {
          super({});
          this.state = { v: 0 };
        }
      }

      const c = new DefaultUpdate();

      expect(() => {
        c.setState({ v: 2 });
      }).not.toThrow();

      expect(c.state.v).toBe(2);
    });

    it('function setState keeps other state fields on partial update', () => {
      const c = new TestComponent({ id: '1' }, { count: 10, label: 'keep' });

      c.setState(() => ({ count: 0 }));

      expect(c.state).toEqual({ count: 0, label: 'keep' });
      expect(c.updates).toHaveLength(1);
    });
  });
});

