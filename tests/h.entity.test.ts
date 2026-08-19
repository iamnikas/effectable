/**
 * Unit tests for the virtual node factory `h` (including key support).
 *
 * @module Effectable/component/h.entity.test
 */

import { Component, h } from 'Effectable';
import type { RefObject, VirtualServiceNode } from 'Effectable';

class EmptyProps extends Component<Record<string, unknown>, Record<string, unknown>> {
  constructor () {
    super({});
  }
}

class WithProps extends Component<Record<string, unknown>, { id: number }> {
  constructor (props: { id: number }) {
    super(props);
  }
}

describe('h()', () => {
  it('returns a node without ref and with empty children for two arguments', () => {
    const node = h(EmptyProps, {});

    expect(node.type).toBe(EmptyProps);
    expect(node.props).toEqual({});
    expect(node.ref).toBeUndefined();
    expect(node.children).toEqual([]);
    expect(node.key).toBeUndefined();
  });

  it('accepts a children array as the third argument without ref', () => {
    const child = h(EmptyProps, {});
    const node = h(EmptyProps, {}, [child]);

    expect(node.ref).toBeUndefined();
    expect(node.children).toHaveLength(1);
    expect(node.children[0]).toBe(child);
  });

  it('accepts ref as the third argument and empty children by default', () => {
    const ref: RefObject<WithProps> = { current: null };
    const node = h(WithProps, { id: 1 }, ref);

    expect(node.ref).toBe(ref);
    expect(node.children).toEqual([]);
  });

  it('accepts ref and a children array as the fourth argument', () => {
    const ref: RefObject<WithProps> = { current: null };
    const child = h(EmptyProps, {});
    const node = h(WithProps, { id: 2 }, ref, [child]);

    expect(node.ref).toBe(ref);
    expect(node.children).toEqual([child]);
  });

  it('treats an empty children array as no children', () => {
    const node = h(EmptyProps, {}, []);

    expect(node.children).toEqual([]);
  });

  it('accepts key as the third argument (string), without ref or children', () => {
    const node = h(WithProps, { id: 7 }, 'btc');

    expect(node.key).toBe('btc');
    expect(node.ref).toBeUndefined();
    expect(node.children).toEqual([]);
  });

  it('accepts children + key (third is array, fourth is string)', () => {
    const child = h(EmptyProps, {});
    const node = h(WithProps, { id: 8 }, [child], 'list-item');

    expect(node.key).toBe('list-item');
    expect(node.ref).toBeUndefined();
    expect(node.children).toEqual([child]);
  });

  it('accepts ref + key (third is ref, fourth is string)', () => {
    const ref: RefObject<WithProps> = { current: null };
    const node = h(WithProps, { id: 9 }, ref, 'with-ref');

    expect(node.key).toBe('with-ref');
    expect(node.ref).toBe(ref);
    expect(node.children).toEqual([]);
  });

  it('accepts ref + children + key (third is ref, fourth is array, fifth is string)', () => {
    const ref: RefObject<WithProps> = { current: null };
    const child = h(EmptyProps, {});
    const node = h(WithProps, { id: 10 }, ref, [child], 'stable-key');

    expect(node.key).toBe('stable-key');
    expect(node.ref).toBe(ref);
    expect(node.children).toEqual([child]);
  });

  it('G10: null and undefined in children array are preserved without throw', () => {
    const child = h(EmptyProps, {});
    const holey: VirtualServiceNode[] = [child];
    holey.push(null as unknown as VirtualServiceNode);
    holey.push(undefined as unknown as VirtualServiceNode);

    expect(() => {
      h(EmptyProps, {}, holey);
    }).not.toThrow();

    const node = h(EmptyProps, {}, holey);

    expect(node.children).toHaveLength(3);
    expect(node.children[0]).toBe(child);
    expect(node.children[1]).toBeNull();
    expect(node.children[2]).toBeUndefined();
  });

  it('G10: null as third argument goes to ref, not children', () => {
    const node = h(
      EmptyProps,
      {},
      null as unknown as RefObject<EmptyProps>,
    );

    expect(node.ref).toBeNull();
    expect(node.children).toEqual([]);
  });

  it('H-10: repeated h(type, props) without children share one EMPTY_CHILDREN ref', () => {
    const first = h(EmptyProps, {});
    const second = h(WithProps, { id: 1 });

    expect(first.children).toBe(second.children);
    expect(first.children).toEqual([]);
  });
});
