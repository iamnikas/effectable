/**
 * Unit tests for ref factory and decorators without mounting GraphRuntime.
 *
 * @module Effectable/component/refs.entity.test
 */

import {
  Component,
  GraphRuntime,
  IMPERATIVE_HANDLE_META_KEY,
  REF_FIELDS_META_KEY,
  getImperativeHandleMethods,
  getRefFields,
  h,
  UseImperativeHandle,
  UseRef,
} from 'Effectable';
import type { RefObject, VirtualServiceNode } from 'Effectable';

class RefHostTwo extends Component<Record<string, unknown>, Record<string, unknown>> {
  @UseRef()
  declare firstRef: RefObject<Component>;

  @UseRef()
  declare secondRef: RefObject<Component>;

  constructor () {
    super({});
  }
}

describe('UseRef / UseImperativeHandle metadata', () => {
  class RefHost extends Component<Record<string, unknown>, Record<string, unknown>> {
    @UseRef()
    declare childRef: RefObject<Component>;

    @UseImperativeHandle()
    public ping (): string {
      return 'pong';
    }

    constructor () {
      super({});
    }
  }

  it('registers fields in REF_FIELDS_META_KEY', () => {
    const ctor = RefHost as unknown as { [key: symbol]: unknown };
    const meta = ctor[REF_FIELDS_META_KEY];
    expect(Array.isArray(meta)).toBe(true);
    expect((meta as { propertyKey: string }[])[0]?.propertyKey).toBe('childRef');
  });

  it('registers methods in IMPERATIVE_HANDLE_META_KEY', () => {
    const ctor = RefHost as unknown as { [key: symbol]: unknown };
    const meta = ctor[IMPERATIVE_HANDLE_META_KEY];
    expect(Array.isArray(meta)).toBe(true);
    expect((meta as { methodKey: string }[])[0]?.methodKey).toBe('ping');
  });

  it('getRefFields and getImperativeHandleMethods return metadata', () => {
    expect(getRefFields(RefHost as unknown as Parameters<typeof getRefFields>[0])).toHaveLength(1);
    expect(
      getImperativeHandleMethods(RefHost as unknown as Parameters<typeof getImperativeHandleMethods>[0])
    ).toHaveLength(1);
  });

  it('REF-06: getRefFields on a class without @UseRef returns []', () => {
    class PlainHost extends Component<Record<string, unknown>, Record<string, unknown>> {
      constructor () {
        super({});
      }
    }

    const plainCtor: Parameters<typeof getRefFields>[0] = PlainHost as unknown as Parameters<
      typeof getRefFields
    >[0];
    const plainImperativeCtor: Parameters<typeof getImperativeHandleMethods>[0] =
      PlainHost as unknown as Parameters<typeof getImperativeHandleMethods>[0];

    expect(getRefFields(plainCtor)).toEqual([]);
    expect(getImperativeHandleMethods(plainImperativeCtor)).toEqual([]);
  });

  it('UseRef defines a getter on the prototype (lazy RefObject on access)', () => {
    const host = new RefHost();
    const desc = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(host) as object,
      'childRef',
    );
    expect(typeof desc?.get).toBe('function');
    expect(desc?.get!.call(host).current).toBeNull();
  });

  it('multiple @UseRef register both fields and yield different RefObjects', () => {
    expect(getRefFields(RefHostTwo as unknown as Parameters<typeof getRefFields>[0])).toHaveLength(2);

    const host = new RefHostTwo();
    const a = host.firstRef;
    const b = host.secondRef;

    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(a).not.toBe(b);
    expect(a.current).toBeNull();
    expect(b.current).toBeNull();
  });

  it('rereading the same ref field returns the same RefObject', () => {
    const host = new RefHost();
    const first = host.childRef;
    const second = host.childRef;

    expect(first).toBe(second);
    expect(first.current).toBeNull();
  });
});

describe('REF-07 GraphRuntime ref.current bind/clear', () => {
  class RefLeaf extends Component<Record<string, never>, { id: string }> {
    constructor (props: { id: string }) {
      super(props);
      this.state = {};
    }
  }

  class RefParent extends Component<Record<string, never>, Record<string, never>> {
    @UseRef()
    declare childRef: RefObject<RefLeaf>;

    constructor () {
      super({});
      this.state = {};
    }

    public override compose (): VirtualServiceNode[] {
      return [h(RefLeaf, { id: 'leaf' }, this.childRef)];
    }
  }

  it('REF-07: after mount ref.current points to child, after unmount — null', async () => {
    const runtime = await GraphRuntime.mount(h(RefParent, {}));
    const root = runtime.getRootInstance() as RefParent | null;
    expect(root).not.toBeNull();
    if (root === null) {
      throw new Error('expected RefParent');
    }

    expect(root.childRef.current).toBeInstanceOf(RefLeaf);
    expect(root.childRef.current?.props.id).toBe('leaf');

    await runtime.unmount();

    expect(root.childRef.current).toBeNull();
  });
});
