/**
 * J13: ContextProvider chain depth=32 + consumer leaf reads value on mount.
 */

import {
  Component,
  ContextProvider,
  GraphRuntime,
  UseContext,
  UseRef,
  createContext,
  h,
} from 'Effectable';
import { IS_CONTEXT_PROVIDER } from 'Effectable/component/context';
import type { ContextScope, RefObject, VirtualServiceNode } from 'Effectable';

jest.setTimeout(120_000);

const CHAIN_DEPTH = 32;
const RESILIENCE_TOKEN = createContext<number>('RESILIENCE_CTX', -1);

interface ProviderShellProps {
  value: [typeof RESILIENCE_TOKEN, number];
  innerNodes: VirtualServiceNode[];
}

/**
 * Provider shell: {@link ContextProvider} with `compose() === null` does not materialize `h`-children.
 */
class ProviderShell extends Component<Record<string, never>, ProviderShellProps> {
  constructor (props: ProviderShellProps) {
    super(props);
  }

  public applyToScope (parentScope: ContextScope): ContextScope {
    const delegate = new ContextProvider({ value: this.props.value });
    return delegate.applyToScope(parentScope);
  }

  public override compose (): VirtualServiceNode[] {
    return this.props.innerNodes;
  }
}

Object.defineProperty(ProviderShell.prototype, IS_CONTEXT_PROVIDER, {
  value: true,
  writable: false,
  enumerable: false,
  configurable: false,
});

class ConsumerLeaf extends Component<Record<string, never>, Record<string, never>> {
  @UseContext(RESILIENCE_TOKEN)
  public injectedValue = -1;

  public receivedOnMount: number | undefined;

  constructor () {
    super({});
  }

  public override onMount (): void {
    this.receivedOnMount = this.injectedValue;
  }
}

class ChainRoot extends Component<Record<string, never>, { value: number }> {
  @UseRef()
  private declare leafRef: RefObject<ConsumerLeaf>;

  constructor (props: { value: number }) {
    super(props);
  }

  public getLeafRef (): RefObject<ConsumerLeaf> {
    return this.leafRef;
  }

  public override compose (): VirtualServiceNode[] {
    let tree: VirtualServiceNode = h(ConsumerLeaf, {}, this.leafRef);

    for (let level = 0; level < CHAIN_DEPTH; level += 1) {
      tree = h(ProviderShell, {
        value: [RESILIENCE_TOKEN, this.props.value],
        innerNodes: [tree],
      });
    }

    return [tree];
  }
}

const SHADOW_OUTER = 1;
const SHADOW_INNER_INITIAL = 2;
const SHADOW_INNER_AFTER_RECONCILE = 99;

class ShadowConsumer extends Component<Record<string, never>, Record<string, never>> {
  @UseContext(RESILIENCE_TOKEN)
  public injectedValue = -1;

  public receivedOnMount: number | undefined;

  constructor () {
    super({});
  }

  public override onMount (): void {
    this.receivedOnMount = this.injectedValue;
  }
}

class ShadowRoot extends Component<Record<string, never>, { innerValue: number }> {
  @UseRef()
  private declare consumerRef: RefObject<ShadowConsumer>;

  constructor (props: { innerValue: number }) {
    super(props);
  }

  public getConsumerRef (): RefObject<ShadowConsumer> {
    return this.consumerRef;
  }

  public override compose (): VirtualServiceNode[] {
    const inner: VirtualServiceNode = h(ProviderShell, {
      value: [RESILIENCE_TOKEN, this.props.innerValue],
      innerNodes: [h(ShadowConsumer, {}, this.consumerRef)],
    });

    return [
      h(ProviderShell, {
        value: [RESILIENCE_TOKEN, SHADOW_OUTER],
        innerNodes: [inner],
      }),
    ];
  }
}

describe('GraphRuntime — resilience J11', () => {
  it('ProviderShell: outer provider 1, inner 2 — consumer sees 2 (shadowing)', async () => {
    const runtime = await GraphRuntime.mount(h(ShadowRoot, { innerValue: SHADOW_INNER_INITIAL }));

    const root = runtime.getRootInstance() as ShadowRoot | null;
    expect(root).not.toBeNull();

    if (root === null) {
      throw new Error('expected ShadowRoot');
    }

    const consumerRef = root.getConsumerRef();
    expect(consumerRef.current).not.toBeNull();

    if (consumerRef.current === null) {
      throw new Error('expected ShadowConsumer');
    }

    expect(consumerRef.current.receivedOnMount).toBe(SHADOW_INNER_INITIAL);
    expect(consumerRef.current.injectedValue).toBe(SHADOW_INNER_INITIAL);

    await runtime.unmount();
  });
});

describe('GraphRuntime — resilience J12 (issue #15 fixed)', () => {
  it('changing inner ProviderShell value on reconcile DOES reinject @UseContext — consumer receives new value', async () => {
    const runtime = await GraphRuntime.mount(h(ShadowRoot, { innerValue: SHADOW_INNER_INITIAL }));

    const root = runtime.getRootInstance() as ShadowRoot | null;
    expect(root).not.toBeNull();

    if (root === null) {
      throw new Error('expected ShadowRoot');
    }

    const consumerRef = root.getConsumerRef();
    expect(consumerRef.current).not.toBeNull();

    if (consumerRef.current === null) {
      throw new Error('expected ShadowConsumer');
    }

    expect(consumerRef.current.injectedValue).toBe(SHADOW_INNER_INITIAL);

    await runtime.reconcile(h(ShadowRoot, { innerValue: SHADOW_INNER_AFTER_RECONCILE }));

    expect(consumerRef.current.injectedValue).toBe(SHADOW_INNER_AFTER_RECONCILE);
    expect(consumerRef.current.receivedOnMount).toBe(SHADOW_INNER_INITIAL);

    await runtime.unmount();
  });
});

describe('GraphRuntime — resilience J13', () => {
  it('ContextProvider chain depth=32 delivers value to consumer leaf on mount', async () => {
    const runtime = await GraphRuntime.mount(h(ChainRoot, { value: 42 }));

    expect(runtime.isActive()).toBe(true);

    const root = runtime.getRootInstance() as ChainRoot | null;
    expect(root).not.toBeNull();

    if (root === null) {
      throw new Error('expected ChainRoot instance');
    }

    const leafRef = root.getLeafRef();
    expect(leafRef.current).not.toBeNull();

    if (leafRef.current === null) {
      throw new Error('expected mounted ConsumerLeaf');
    }

    expect(leafRef.current.receivedOnMount).toBe(42);
    expect(leafRef.current.injectedValue).toBe(42);

    await runtime.unmount();
    expect(runtime.isActive()).toBe(false);
  });
});
