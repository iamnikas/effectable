/**
 * Repro: subclass of Connected with prototype onMount/onUnmount overrides.
 * After #74 own-property reinstall, Ext.prototype hooks are shadowed and never run.
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';

describe('connect subclass prototype lifecycle', () => {
  interface S {
    n: number;
  }

  type A = { type: 'INC' };

  function makeStore () {
    return createStore<S, A>(
      (s, a) => (a.type === 'INC' ? { n: s.n + 1 } : s),
      { n: 0 },
    );
  }

  it('Ext.prototype onMount/onUnmount run and store wiring still works', async () => {
    const store = makeStore();
    const calls: string[] = [];

    class Svc extends Component<Record<string, never>, { n?: number }> {
      public override onMount (): void {
        calls.push(`svc-mount:n=${String(this.props.n)}`);
      }

      public override onUnmount (): void {
        calls.push('svc-unmount');
      }
    }

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Svc);

    class Ext extends Connected {
      public override onMount (): void {
        calls.push('ext-mount');
        super.onMount();
      }

      public override onUnmount (): void {
        calls.push('ext-unmount');
        super.onUnmount();
      }
    }

    const rt = await GraphRuntime.mount(h(Ext, {}));
    const inst = rt.getRootInstance() as InstanceType<typeof Ext>;

    expect(calls).toEqual(['ext-mount', 'svc-mount:n=0']);
    expect(inst.props.n).toBe(0);

    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    expect(inst.props.n).toBe(1);

    await rt.unmount();
    expect(calls).toEqual([
      'ext-mount',
      'svc-mount:n=0',
      'ext-unmount',
      'svc-unmount',
    ]);
  });
});
