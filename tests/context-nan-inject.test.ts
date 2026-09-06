/**
 * Regression: stable NaN context values must use Object.is identity in
 * injectContextFields. ContextProvider.applyToScope builds a fresh Map every
 * pass, so GraphRuntime always re-injects under providers; `!==` treated NaN as
 * always-changed and spuriously called onUpdate (unbounded cascade if onUpdate
 * setStates an ancestor).
 *
 * @module Effectable/tests/context-nan-inject.test
 */

import {
  Component,
  ContextProvider,
  EMPTY_CONTEXT_SCOPE,
  GraphRuntime,
  UseContext,
  UseRef,
  createContext,
  extendScope,
  h,
  injectContextFields,
} from 'Effectable';
import type { RefObject, VirtualServiceNode } from 'Effectable';

const NAN_CTX = createContext<number>('NAN_CTX');

describe('injectContextFields stable NaN (Object.is)', () => {
  it('second inject of the same NaN returns false', () => {
    class Consumer {
      @UseContext(NAN_CTX)
      public value = 0;
    }

    const instance = new Consumer();
    const scope = extendScope(EMPTY_CONTEXT_SCOPE, NAN_CTX, Number.NaN);

    expect(injectContextFields(instance, scope)).toBe(true);
    expect(Number.isNaN(instance.value)).toBe(true);
    expect(injectContextFields(instance, scope)).toBe(false);
  });

  it('still reports change when NaN is replaced by a finite number', () => {
    class Consumer {
      @UseContext(NAN_CTX)
      public value = 0;
    }

    const instance = new Consumer();
    injectContextFields(instance, extendScope(EMPTY_CONTEXT_SCOPE, NAN_CTX, Number.NaN));
    expect(injectContextFields(instance, extendScope(EMPTY_CONTEXT_SCOPE, NAN_CTX, 1))).toBe(true);
    expect(instance.value).toBe(1);
  });

  it('stable NaN provider value does not call onUpdate on reconcile', async () => {
    // Stable props identity so only contextChanged can drive onUpdate.
    // Forward vnode props into super() so mount props === stableConsumerProps.
    const stableConsumerProps: Record<string, never> = {};

    class Consumer extends Component<Record<string, never>, Record<string, never>> {
      @UseContext(NAN_CTX)
      public value = 0;

      public onUpdateHits = 0;

      constructor (props: Record<string, never>) {
        super(props);
      }

      public override onUpdate (): void {
        this.onUpdateHits += 1;
      }
    }

    class Root extends Component<Record<string, never>, { tick: number }> {
      @UseRef()
      private declare consumerRef: RefObject<Consumer>;

      constructor (props: { tick: number }) {
        super(props);
      }

      public getConsumer (): Consumer | null {
        return this.consumerRef.current;
      }

      public override compose (): VirtualServiceNode[] {
        return [
          h(ContextProvider, { value: [NAN_CTX, Number.NaN] }, [
            h(Consumer, stableConsumerProps, this.consumerRef),
          ]),
        ];
      }
    }

    const runtime = await GraphRuntime.mount(h(Root, { tick: 0 }));
    const root = runtime.getRootInstance() as Root;
    const consumer = root.getConsumer();
    expect(consumer).not.toBeNull();
    expect(Number.isNaN(consumer!.value)).toBe(true);
    expect(consumer!.onUpdateHits).toBe(0);

    await runtime.reconcile(h(Root, { tick: 1 }));
    await runtime.reconcile(h(Root, { tick: 2 }));
    await runtime.reconcile(h(Root, { tick: 3 }));

    expect(consumer!.onUpdateHits).toBe(0);

    await runtime.unmount();
  });

  it('onUpdate setState of ancestor + stable NaN does not unbounded-cascade', async () => {
    let updateHits = 0;
    const stableConsumerProps: Record<string, never> = {};

    class Consumer extends Component<Record<string, never>, Record<string, never>> {
      @UseContext(NAN_CTX)
      public value = 0;

      public root: Root | null = null;

      constructor (props: Record<string, never>) {
        super(props);
      }

      public override onUpdate (): void {
        updateHits += 1;
        if (this.root !== null && updateHits < 40) {
          this.root.setState({ tick: this.root.state.tick + 1 });
        }
      }
    }

    class Root extends Component<{ tick: number }, { seed: number }> {
      @UseRef()
      private declare consumerRef: RefObject<Consumer>;

      constructor (props: { seed: number }) {
        super(props);
        this.state = { tick: 0 };
      }

      public override onMount (): void {
        const consumer = this.consumerRef.current;
        if (consumer !== null) {
          consumer.root = this;
        }
      }

      public override compose (): VirtualServiceNode[] {
        void this.state.tick;
        return [
          h(ContextProvider, { value: [NAN_CTX, Number.NaN] }, [
            h(Consumer, stableConsumerProps, this.consumerRef),
          ]),
        ];
      }
    }

    const runtime = await GraphRuntime.mount(h(Root, { seed: 1 }));
    const root = runtime.getRootInstance() as Root;
    root.setState({ tick: 1 });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50);
    });

    // Without Object.is this climbed to the 40 guard via contextChanged→onUpdate→setState.
    expect(updateHits).toBe(0);

    await runtime.unmount();
  });
});
