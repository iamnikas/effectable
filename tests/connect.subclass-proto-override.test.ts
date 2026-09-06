/**
 * Critical: #74 reinstalled Connected onMount/onUnmount as own properties on every
 * instance. That shadowed subclass prototype overrides (`class Ext extends Connected {
 * override onMount() { …; super.onMount(); } }`), so Ext lifecycle never ran while
 * Base's still did via Constructor.prototype — silent skip of subclass setup/teardown.
 */
import {
  Component,
  GraphRuntime,
  connect,
  createStore,
  h,
} from 'Effectable';

describe('connect subclass prototype override of Connected', () => {
  interface S {
    n: number;
  }

  type A = { type: 'INC' };

  function makeStore () {
    return createStore<S, A>(
      (s, a) => (a.type === 'INC' ? { n: s.n + 1 } : s),
      { n: 0 }
    );
  }

  it('Ext.prototype.onMount/onUnmount run via super chain; store wiring still works', async () => {
    const store = makeStore();
    const calls: string[] = [];

    class Base extends Component<Record<string, never>, { n?: number }> {
      public override onMount (): void {
        calls.push(`base:n=${String(this.props.n)}`);
      }

      public override onUnmount (): void {
        calls.push('base-un');
      }
    }

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Base);

    class Ext extends Connected {
      public override onMount (): void {
        calls.push('ext');
        super.onMount();
      }

      public override onUnmount (): void {
        calls.push('ext-un');
        super.onUnmount();
      }
    }

    const rt = await GraphRuntime.mount(h(Ext, {}));
    const inst = rt.getRootInstance() as InstanceType<typeof Ext>;

    expect(Object.prototype.hasOwnProperty.call(inst, 'onMount')).toBe(false);
    expect(calls).toEqual(['ext', 'base:n=0']);
    expect(inst.props.n).toBe(0);

    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    expect(inst.props.n).toBe(1);

    await rt.unmount();
    expect(calls).toEqual(['ext', 'base:n=0', 'ext-un', 'base-un']);
  });

  it('wrapped class-field onMount still gets connect wiring (no subclass)', async () => {
    const store = makeStore();
    const calls: string[] = [];

    class Svc extends Component<Record<string, never>, { n?: number }> {
      public override onMount = (): void => {
        calls.push(`mount:n=${String(this.props.n)}`);
      };
    }

    const Connected = connect(store, (s: S) => ({ n: s.n }))(Svc);
    const rt = await GraphRuntime.mount(h(Connected, {}));
    const inst = rt.getRootInstance() as InstanceType<typeof Connected>;

    expect(Object.prototype.hasOwnProperty.call(inst, 'onMount')).toBe(true);
    expect(calls).toEqual(['mount:n=0']);
    expect(inst.props.n).toBe(0);

    store.dispatch({ type: 'INC' });
    await Promise.resolve();
    expect(inst.props.n).toBe(1);

    await rt.unmount();
  });
});
