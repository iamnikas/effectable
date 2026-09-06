/**
 * Regression: dynamic key assignment of `__proto__` must not invoke the
 * Object.prototype `__proto__` setter (prototype pollution / lost keys).
 *
 * Affects createStructuredSelector, buildSemanticStateTree, and connect's
 * action-creators mapDispatch binder.
 */
import {
  Component,
  buildSemanticStateTree,
  connect,
  createStore,
  createStructuredSelector,
} from 'effectable';

describe('store/connect __proto__ key assignment safety', () => {
  test('createStructuredSelector: __proto__ selector stays an own result field', () => {
    const selectors: Record<string, (s: { n: number }) => unknown> = Object.create(null);
    selectors['__proto__'] = () => ({ admin: true, role: 'root' });
    selectors['n'] = (s) => s.n;

    const select = createStructuredSelector(selectors as {
      __proto__: (s: { n: number }) => { admin: boolean; role: string };
      n: (s: { n: number }) => number;
    });
    const result = select({ n: 1 }) as Record<string, unknown>;

    expect(Object.keys(result).sort()).toEqual(['__proto__', 'n'].sort());
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result['n']).toBe(1);
    expect(result['__proto__']).toEqual({ admin: true, role: 'root' });
    expect(Object.prototype.hasOwnProperty.call(result, 'admin')).toBe(false);
    expect((result as { role?: string }).role).toBeUndefined();
  });

  test('buildSemanticStateTree: __proto__ state key remains in keys bag', () => {
    const state: Record<string, unknown> = Object.create(null);
    state['x'] = 1;
    state['__proto__'] = { admin: true };

    const tree = buildSemanticStateTree(state) as {
      kind: string;
      keys: Record<string, { kind: string }>;
    };

    expect(tree.kind).toBe('object');
    expect(Object.getPrototypeOf(tree.keys)).toBeNull();
    expect(Object.keys(tree.keys).sort()).toEqual(['__proto__', 'x'].sort());
    expect(tree.keys['__proto__']?.kind).toBe('object');
    expect((tree.keys as { kind?: string }).kind).toBeUndefined();
  });

  test('connect mapDispatch action-creators: __proto__ creator is bound onto props', () => {
    const store = createStore(
      (s = { n: 0 }, a: { type: string }) => (a.type === 'P' ? { n: s.n + 1 } : s),
      { n: 0 },
    );

    const creators: Record<string, (...args: unknown[]) => { type: string }> = Object.create(null);
    creators['__proto__'] = () => ({ type: 'P' });
    creators['inc'] = () => ({ type: 'P' });

    class Host extends Component<Record<string, unknown>> {}
    const Connected = connect(store, null, creators as never)(Host);
    const inst = new Connected({});
    void inst.onMount!();

    expect(typeof (inst.props as { inc?: unknown }).inc).toBe('function');
    expect(typeof (inst.props as Record<string, unknown>)['__proto__']).toBe('function');

    ((inst.props as Record<string, unknown>)['__proto__'] as () => void)();
    expect(store.getState().n).toBe(1);

    store.destroy();
  });
});
