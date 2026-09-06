/**
 * Regression: GraphRuntime must honor @UseImperativeHandle allowlist on ref.current.
 *
 * Before the fix, commitRef assigned the full Component instance, so undecorated
 * methods and fields remained reachable via the parent ref despite the contract in
 * refs.ts / CONCEPT (limited public imperative API).
 */

import {
  Component,
  GraphRuntime,
  UseImperativeHandle,
  UseRef,
  h,
} from 'Effectable';
import type { RefObject } from 'Effectable';

describe('GraphRuntime @UseImperativeHandle allowlist on ref.current', () => {
  class LeakyChild extends Component<Record<string, unknown>, Record<string, unknown>> {
    public secret = 'SECRET';

    constructor () {
      super({});
    }

    @UseImperativeHandle()
    public safe (): string {
      return 'ok';
    }

    public leak (): string {
      return this.secret;
    }
  }

  class Parent extends Component<Record<string, unknown>, Record<string, unknown>> {
    @UseRef()
    public declare childRef: RefObject<LeakyChild>;

    constructor () {
      super({});
    }

    public override compose (): ReturnType<typeof h>[] {
      return [h(LeakyChild, {}, this.childRef)];
    }
  }

  class PlainChild extends Component<Record<string, unknown>, Record<string, unknown>> {
    public tag = 'plain';

    constructor () {
      super({});
    }
  }

  class PlainParent extends Component<Record<string, unknown>, Record<string, unknown>> {
    @UseRef()
    public declare childRef: RefObject<PlainChild>;

    constructor () {
      super({});
    }

    public override compose (): ReturnType<typeof h>[] {
      return [h(PlainChild, {}, this.childRef)];
    }
  }

  it('exposes only @UseImperativeHandle methods — not other methods or fields', async () => {
    const runtime = await GraphRuntime.mount(h(Parent, {}));
    const parent = runtime.getRootInstance() as Parent | null;
    expect(parent).not.toBeNull();
    if (parent === null) {
      throw new Error('expected Parent');
    }

    const current = parent.childRef.current as unknown as Record<string, unknown> | null;
    expect(current).not.toBeNull();
    if (current === null) {
      throw new Error('expected child ref');
    }

    // Allowlisted API works and is bound to the instance.
    expect(typeof current['safe']).toBe('function');
    expect((current['safe'] as () => string)()).toBe('ok');

    // Full instance must not leak through the ref.
    expect(current instanceof LeakyChild).toBe(false);
    expect(current['leak']).toBeUndefined();
    expect(current['secret']).toBeUndefined();
    expect(Object.keys(current)).toEqual(['safe']);

    await runtime.unmount();
    expect(parent.childRef.current).toBeNull();
  });

  it('still assigns the full instance when no @UseImperativeHandle methods exist', async () => {
    const runtime = await GraphRuntime.mount(h(PlainParent, {}));
    const parent = runtime.getRootInstance() as PlainParent | null;
    expect(parent).not.toBeNull();
    if (parent === null) {
      throw new Error('expected PlainParent');
    }

    expect(parent.childRef.current).toBeInstanceOf(PlainChild);
    expect(parent.childRef.current?.tag).toBe('plain');

    await runtime.unmount();
    expect(parent.childRef.current).toBeNull();
  });
});
