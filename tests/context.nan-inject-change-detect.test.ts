/**
 * Regression: injectContextFields must use SameValue (`Object.is`) so a stable
 * NaN context value does not look changed on every reinject.
 *
 * ContextProvider publishes a new scope Map on each parent reconcile. GraphRuntime
 * re-injects when the fiber scope identity changes and treats a true return as
 * contextChanged → onUpdate. With `!==`, `NaN !== NaN` is always true, so a child
 * whose onUpdate setStates an ancestor livelocks even when the provided NaN never
 * changed (and child props identity is stable).
 *
 * Distinct from store `select` / connect own-props NaN gates.
 */

import {
  Component,
  ContextProvider,
  EMPTY_CONTEXT_SCOPE,
  GraphRuntime,
  UseContext,
  createContext,
  extendScope,
  h,
  injectContextFields,
} from 'Effectable';
import type { VirtualServiceNode } from 'Effectable';

describe('injectContextFields SameValue for stable NaN', () => {
  it('does not report change when reinjecting the same NaN', () => {
    const Tok = createContext<number>('nanInjectUnit');

    class Host extends Component {
      @UseContext(Tok)
      public value!: number;
    }

    const instance = new Host({});
    const scope = extendScope(EMPTY_CONTEXT_SCOPE, Tok, Number.NaN);

    expect(injectContextFields(instance, scope)).toBe(true);
    expect(Number.isNaN(instance.value)).toBe(true);
    expect(injectContextFields(instance, scope)).toBe(false);
  });

  it('does not cascade onUpdate when ContextProvider value is stable NaN', async () => {
    const Tok = createContext<number>('nanInjectCascade');
    let hits = 0;
    let parentRef: Parent | null = null;
    const childProps: Record<string, never> = {};
    const maxHits = 40;

    class Child extends Component {
      @UseContext(Tok)
      public value!: number;

      public override onUpdate (): void {
        hits += 1;
        if (hits >= maxHits) {
          return;
        }
        if (parentRef !== null) {
          parentRef.setState({ n: parentRef.state.n + 1 });
        }
      }
    }

    // Stable child vnode/props so UPDATE is driven by context reinject, not props identity.
    const childNode: VirtualServiceNode = h(Child, childProps);

    class Parent extends Component<{ n: number }, Record<string, never>> {
      public constructor (props: Record<string, never>) {
        super(props);
        this.state = { n: 0 };
        parentRef = this;
      }

      public override compose () {
        return h(
          ContextProvider,
          { value: [Tok, Number.NaN] as [typeof Tok, number] },
          [childNode],
        );
      }
    }

    const rt = await GraphRuntime.mount(h(Parent, {}));
    expect(hits).toBe(0);

    parentRef!.setState({ n: 1 });
    for (let i = 0; i < 80; i += 1) {
      await Promise.resolve();
    }

    expect(hits).toBe(0);
    expect(parentRef!.state.n).toBe(1);
    await rt.unmount();
  });

  it('finite stable context with stable child props does not fire onUpdate', async () => {
    const Tok = createContext<number>('finiteInjectCascade');
    let hits = 0;
    let parentRef: Parent | null = null;
    const childProps: Record<string, never> = {};

    class Child extends Component {
      @UseContext(Tok)
      public value!: number;

      public override onUpdate (): void {
        hits += 1;
        if (parentRef !== null && hits < 10) {
          parentRef.setState({ n: parentRef.state.n + 1 });
        }
      }
    }

    const childNode: VirtualServiceNode = h(Child, childProps);

    class Parent extends Component<{ n: number }, Record<string, never>> {
      public constructor (props: Record<string, never>) {
        super(props);
        this.state = { n: 0 };
        parentRef = this;
      }

      public override compose () {
        return h(
          ContextProvider,
          { value: [Tok, 42] as [typeof Tok, number] },
          [childNode],
        );
      }
    }

    const rt = await GraphRuntime.mount(h(Parent, {}));
    parentRef!.setState({ n: 1 });
    for (let i = 0; i < 80; i += 1) {
      await Promise.resolve();
    }

    expect(hits).toBe(0);
    await rt.unmount();
  });

  it('still delivers onUpdate when context value changes from NaN to finite', async () => {
    const Tok = createContext<number>('nanInjectTransition');
    let seen: number | undefined;
    let parentRef: Parent | null = null;
    const childProps: Record<string, never> = {};

    class Child extends Component {
      @UseContext(Tok)
      public value!: number;

      public override onUpdate (): void {
        seen = this.value;
      }
    }

    const childNode: VirtualServiceNode = h(Child, childProps);

    class Parent extends Component<{ n: number }, { useFinite: boolean }> {
      public constructor (props: { useFinite: boolean }) {
        super(props);
        this.state = { n: 0 };
        parentRef = this;
      }

      public override compose () {
        const value = this.props.useFinite ? 7 : Number.NaN;
        return h(
          ContextProvider,
          { value: [Tok, value] as [typeof Tok, number] },
          [childNode],
        );
      }
    }

    const rt = await GraphRuntime.mount(h(Parent, { useFinite: false }));
    expect(seen).toBe(undefined);

    // Mutate own props then dirty-flush so compose publishes a finite value.
    (parentRef as Parent).props = { useFinite: true };
    parentRef!.setState({ n: 1 });
    for (let i = 0; i < 20; i += 1) {
      await Promise.resolve();
    }

    expect(seen).toBe(7);
    await rt.unmount();
  });
});
