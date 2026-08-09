/**
 * Tests for the semantic state tree of Effectable store.
 */

import {
  createStore,
  buildSemanticStateTree,
  buildSemanticStateTreeFromReducerMap,
  buildSemanticStateTreeFromStore,
  semanticStateTreeToJsonString,
} from 'Effectable';
import type { AnyAction, Reducer } from 'Effectable';

describe('semanticStateTree', () => {
  describe('buildSemanticStateTree', () => {
    it('describes primitives and a nested plain object', () => {
      const tree = buildSemanticStateTree({
        n: 1,
        s: 'a',
        flag: true,
        nested: { x: null },
      });
      expect(tree).toEqual({
        kind: 'object',
        keys: {
          n: { kind: 'primitive', valueType: 'number' },
          s: { kind: 'primitive', valueType: 'string' },
          flag: { kind: 'primitive', valueType: 'boolean' },
          nested: {
            kind: 'object',
            keys: {
              x: { kind: 'primitive', valueType: 'null' },
            },
          },
        },
      });
    });

    it('undefined / bigint / symbol / function', () => {
      const tree = buildSemanticStateTree({
        u: undefined,
        big: BigInt(10),
        sym: Symbol('s'),
        fn: function namedFn (): void {
          return;
        },
      });
      expect(tree.kind).toBe('object');
      if (tree.kind !== 'object') {
        throw new Error('expected object');
      }
      expect(tree.keys['u']).toEqual({ kind: 'primitive', valueType: 'undefined' });
      expect(tree.keys['big']).toEqual({ kind: 'primitive', valueType: 'bigint' });
      expect(tree.keys['sym']).toEqual({ kind: 'primitive', valueType: 'symbol' });
      expect(tree.keys['fn']).toEqual({ kind: 'nonSerializable', description: 'function' });
    });

    it('describes an array by length and the shape of the first element', () => {
      const tree = buildSemanticStateTree({ items: [1, 2, 3] });
      expect(tree).toEqual({
        kind: 'object',
        keys: {
          items: {
            kind: 'array',
            length: 3,
            item: { kind: 'primitive', valueType: 'number' },
          },
        },
      });
    });

    it('marks a repeated object visit as reference', () => {
      const shared: { tag: string } = { tag: 'x' };
      const tree = buildSemanticStateTree({ a: shared, b: shared });
      expect(tree.kind).toBe('object');
      if (tree.kind !== 'object') {
        return;
      }
      expect(tree.keys['a']).toEqual({
        kind: 'object',
        keys: { tag: { kind: 'primitive', valueType: 'string' } },
      });
      expect(tree.keys['b']).toEqual({ kind: 'reference', reused: true });
    });

    it('truncates depth at maxDepth', () => {
      const tree = buildSemanticStateTree({ a: { b: { c: 1 } } }, { maxDepth: 0 });
      expect(tree).toEqual({
        kind: 'object',
        keys: {
          a: { kind: 'truncated', maxDepthExceeded: true },
        },
      });
    });

    it('E07: Map, Set, Date and class instance — date or nonSerializable', () => {
      const when = new Date('2020-01-15T12:00:00.000Z');
      class Box {
        public value = 1;
      }
      const tree = buildSemanticStateTree({
        when,
        map: new Map<string, number>([['a', 1]]),
        set: new Set<number>([1, 2]),
        box: new Box(),
      });

      expect(tree.kind).toBe('object');
      if (tree.kind !== 'object') {
        return;
      }

      expect(tree.keys['when']).toEqual({
        kind: 'date',
        iso: when.toISOString(),
      });
      expect(tree.keys['map']).toEqual({
        kind: 'nonSerializable',
        description: 'instance:Map',
      });
      expect(tree.keys['set']).toEqual({
        kind: 'nonSerializable',
        description: 'instance:Set',
      });
      expect(tree.keys['box']).toEqual({
        kind: 'nonSerializable',
        description: 'instance:Box',
      });
    });
  });

  describe('buildSemanticStateTreeFromStore', () => {
    it('builds a tree from getState()', () => {
      const reducer: Reducer<{ count: number }, AnyAction> = (state) => {
        return state;
      };
      const store = createStore(reducer, { count: 0 });
      const tree = buildSemanticStateTreeFromStore(store);
      expect(tree).toEqual({
        kind: 'object',
        keys: {
          count: { kind: 'primitive', valueType: 'number' },
        },
      });
    });
  });

  describe('buildSemanticStateTreeFromReducerMap', () => {
    it('builds a tree when reducerMap and initialState keys match', () => {
      const rA: Reducer<unknown, AnyAction> = (s) => {
        return s;
      };
      const rB: Reducer<unknown, AnyAction> = (s) => {
        return s;
      };
      const tree = buildSemanticStateTreeFromReducerMap(
        { a: rA, b: rB },
        { a: { x: 1 }, b: { y: 'z' } }
      );
      expect(tree.kind).toBe('object');
      if (tree.kind !== 'object') {
        return;
      }
      expect(tree.keys['a']).toEqual({
        kind: 'object',
        keys: { x: { kind: 'primitive', valueType: 'number' } },
      });
      expect(tree.keys['b']).toEqual({
        kind: 'object',
        keys: { y: { kind: 'primitive', valueType: 'string' } },
      });
    });

    it('throws when a key is missing from initialState', () => {
      const r: Reducer<unknown, AnyAction> = (s) => {
        return s;
      };
      expect(() => {
        buildSemanticStateTreeFromReducerMap({ a: r }, {});
      }).toThrow();
    });

    it('throws if key exists in initialState but not in reducerMap', () => {
      const r: Reducer<unknown, AnyAction> = (s) => {
        return s;
      };
      expect(() => {
        buildSemanticStateTreeFromReducerMap({ a: r }, { a: 1, orphan: 2 });
      }).toThrow(/reducerMap does not contain key "orphan"/);
    });
  });

  describe('maxKeysPerObject overflow', () => {
    it('when maxKeysPerObject is exceeded adds __semanticOverflow', () => {
      const state: Record<string, number> = {};
      for (let i = 0; i < 5; i += 1) {
        state[`k${String(i)}`] = i;
      }

      const tree = buildSemanticStateTree(state, { maxKeysPerObject: 2 });
      expect(tree.kind).toBe('object');
      if (tree.kind !== 'object') {
        throw new Error('expected object node');
      }

      expect(Object.hasOwn(tree.keys, 'k0')).toBe(true);
      expect(Object.hasOwn(tree.keys, 'k1')).toBe(true);
      expect(Object.hasOwn(tree.keys, 'k2')).toBe(false);
      expect(tree.keys['__semanticOverflow']).toEqual({
        kind: 'nonSerializable',
        description: 'omitted keys: 3',
      });
    });
  });

  describe('semanticStateTreeToJsonString', () => {
    it('returns a valid JSON string', () => {
      const s = semanticStateTreeToJsonString({ k: 1 });
      expect(() => {
        JSON.parse(s);
      }).not.toThrow();
    });

    it('custom space + tree options (maxDepth)', () => {
      const compact = semanticStateTreeToJsonString({ a: 1 }, undefined, 0);
      expect(compact.includes('\n')).toBe(false);
      expect(JSON.parse(compact)).toEqual({
        kind: 'object',
        keys: {
          a: { kind: 'primitive', valueType: 'number' },
        },
      });

      const deepLimited = semanticStateTreeToJsonString(
        { nest: { x: 1 } },
        { maxDepth: 0 },
        2,
      );
      expect(JSON.parse(deepLimited)).toEqual({
        kind: 'object',
        keys: {
          nest: {
            kind: 'truncated',
            maxDepthExceeded: true,
          },
        },
      });
    });
  });

  describe('empty array, null-prototype object, and invalid options', () => {
    it('empty array — item null', () => {
      const tree = buildSemanticStateTree({ items: [] });
      expect(tree).toEqual({
        kind: 'object',
        keys: {
          items: {
            kind: 'array',
            length: 0,
            item: null,
          },
        },
      });
    });

    it('Object.create(null) as plain object', () => {
      const nullProto: Record<string, number> = Object.create(null);
      nullProto['x'] = 1;
      const tree = buildSemanticStateTree(nullProto);
      expect(tree).toEqual({
        kind: 'object',
        keys: {
          x: { kind: 'primitive', valueType: 'number' },
        },
      });
    });

    it('invalid options fall back to DEFAULT_MAX_DEPTH', () => {
      let deep: Record<string, unknown> = { v: 1 };
      for (let i = 0; i < 40; i += 1) {
        deep = { nest: deep };
      }

      const tree = buildSemanticStateTree(deep, {
        maxDepth: Number.NaN,
        maxKeysPerObject: -1,
      });

      expect(tree.kind).toBe('object');
      let cursor: unknown = tree;
      let steps = 0;
      while (
        typeof cursor === 'object'
        && cursor !== null
        && Object.hasOwn(cursor, 'keys')
        && steps < 50
      ) {
        const keysVal = Reflect.get(cursor, 'keys');
        if (typeof keysVal !== 'object' || keysVal === null) {
          break;
        }
        if (!Object.hasOwn(keysVal, 'nest')) {
          break;
        }
        cursor = Reflect.get(keysVal, 'nest');
        steps += 1;
      }

      // depth 0..32 — object; at the 33rd nest — truncated (DEFAULT_MAX_DEPTH=32)
      expect(steps).toBe(33);
      expect(typeof cursor).toBe('object');
      if (typeof cursor !== 'object' || cursor === null) {
        throw new Error('expected depth node');
      }
      expect(Object.hasOwn(cursor, 'maxDepthExceeded')).toBe(true);
    });
  });
});

