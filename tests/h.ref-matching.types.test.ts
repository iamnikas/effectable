/**
 * Type-level call-site matching for `h()` refs under tsconfig.json (`strict`).
 *
 * Generic `h` rejects mismatched / too-wide refs while accepting `RefObject<Child>`.
 * These `@ts-expect-error` directives are the real check — consumed by `npm run typecheck`.
 *
 * @module Effectable/component/h.ref-matching.types.test
 */

import { Component, h } from 'Effectable';
import type { RefObject } from 'Effectable';

class Child extends Component<Record<string, never>, { id: number }> {
  constructor (props: { id: number }) {
    super(props);
  }

  childOnly (): number {
    return this.props.id;
  }
}

class Other extends Component<Record<string, never>, { id: number }> {
  constructor (props: { id: number }) {
    super(props);
  }

  otherOnly (): string {
    return String(this.props.id);
  }
}

describe('h() ref call-site matching (types)', () => {
  it('accepts RefObject<Child> and rejects Other / Component / unknown', () => {
    const childRef: RefObject<Child> = { current: null };
    const otherRef: RefObject<Other> = { current: null };
    const componentRef: RefObject<Component<unknown, { id: number }>> = { current: null };
    const unknownRef: RefObject<unknown> = { current: null };

    // OK — concrete instance ref matches the constructor
    const node = h(Child, { id: 1 }, childRef);
    expect(node.ref).toBe(childRef);

    // @ts-expect-error Other ≠ Child — mismatched instance ref
    h(Child, { id: 1 }, otherRef);

    // @ts-expect-error Component too wide for h(Child, …)
    h(Child, { id: 1 }, componentRef);

    // @ts-expect-error RefObject<unknown> too wide for h(Child, …)
    h(Child, { id: 1 }, unknownRef);
  });
});
