/**
 * Entity tests for createSelector / createStructuredSelector (contracts C01–C05, C08).
 *
 * @module Effectable/store/selector.entity.test
 */

import { createSelector, createStructuredSelector } from 'Effectable';

type CounterState = { count: number };

type NestedState = {
  inner: { value: number };
};

type PairState = {
  a: number;
  b: number;
};

describe('C01 createSelector memo', () => {
  it('with the same inputs combiner is not recomputed (recomputations)', () => {
    const state: CounterState = { count: 3 };
    const selectDoubled = createSelector(
      (s: CounterState) => s.count,
      (count) => count * 2,
    );

    expect(selectDoubled.recomputations()).toBe(0);

    expect(selectDoubled(state)).toBe(6);
    expect(selectDoubled.recomputations()).toBe(1);

    expect(selectDoubled(state)).toBe(6);
    expect(selectDoubled.recomputations()).toBe(1);
  });

  it('recomputes combiner when an input selector result changes', () => {
    let state: CounterState = { count: 1 };
    const selectDoubled = createSelector(
      (s: CounterState) => s.count,
      (count) => count * 2,
    );

    expect(selectDoubled(state)).toBe(2);
    expect(selectDoubled.recomputations()).toBe(1);

    state = { count: 2 };
    expect(selectDoubled(state)).toBe(4);
    expect(selectDoubled.recomputations()).toBe(2);
  });
});

describe('C02 createSelector overloads (1..N input selectors)', () => {
  it('works with one input selector (variadic)', () => {
    const state: CounterState = { count: 5 };
    const select = createSelector(
      (s: CounterState) => s.count,
      (n) => n + 1,
    );

    expect(select(state)).toBe(6);
    expect(select.recomputations()).toBe(1);
  });

  it('works with two input selectors (variadic)', () => {
    const state: PairState = { a: 10, b: 3 };
    const selectSum = createSelector(
      (s: PairState) => s.a,
      (s: PairState) => s.b,
      (a, b) => a + b,
    );

    expect(selectSum(state)).toBe(13);
    expect(selectSum.recomputations()).toBe(1);
  });

  it('works with an array of input selectors', () => {
    const state: PairState = { a: 4, b: 7 };
    const selectProduct = createSelector(
      [(s: PairState) => s.a, (s: PairState) => s.b],
      (a, b) => a * b,
    );

    expect(selectProduct(state)).toBe(28);
    expect(selectProduct.recomputations()).toBe(1);
  });
});

describe('C03 createSelector variadic and array form', () => {
  it('variadic and array yield the same result and memoization', () => {
    const state: PairState = { a: 2, b: 8 };

    const fromVariadic = createSelector(
      (s: PairState) => s.a,
      (s: PairState) => s.b,
      (a, b) => `${a}:${b}`,
    );

    const fromArray = createSelector(
      [(s: PairState) => s.a, (s: PairState) => s.b],
      (a, b) => `${a}:${b}`,
    );

    expect(fromVariadic(state)).toBe('2:8');
    expect(fromArray(state)).toBe('2:8');

    fromVariadic(state);
    fromArray(state);

    expect(fromVariadic.recomputations()).toBe(1);
    expect(fromArray.recomputations()).toBe(1);
  });
});

describe('C04 resetMemoization and independent instances', () => {
  it('resetMemoization clears the cache and the next call recomputes combiner', () => {
    const state: CounterState = { count: 1 };
    const select = createSelector(
      (s: CounterState) => s.count,
      (n) => n * 10,
    );

    expect(select(state)).toBe(10);
    expect(select.recomputations()).toBe(1);

    select(state);
    expect(select.recomputations()).toBe(1);

    select.resetMemoization();
    expect(select.recomputations()).toBe(0);

    expect(select(state)).toBe(10);
    expect(select.recomputations()).toBe(1);
  });

  it('two createSelector instances do not share the memoization cache', () => {
    const state: CounterState = { count: 2 };
    const selectA = createSelector(
      (s: CounterState) => s.count,
      (n) => n + 1,
    );
    const selectB = createSelector(
      (s: CounterState) => s.count,
      (n) => n + 1,
    );

    selectA(state);
    selectB(state);
    expect(selectA.recomputations()).toBe(1);
    expect(selectB.recomputations()).toBe(1);

    selectA.resetMemoization();
    selectA(state);

    expect(selectA.recomputations()).toBe(1);
    expect(selectB.recomputations()).toBe(1);
  });
});

describe('C05 createStructuredSelector', () => {
  it('returns an object with field-selector results', () => {
    type NavState = {
      path: string;
      depth: number;
    };

    const state: NavState = { path: '/home', depth: 2 };

    const selectNav = createStructuredSelector<
      NavState,
      { currentPath: string; level: number }
    >({
      currentPath: (s: NavState) => s.path,
      level: (s: NavState) => s.depth,
    });

    expect(selectNav(state)).toEqual({
      currentPath: '/home',
      level: 2,
    });
    expect(selectNav.recomputations()).toBe(1);

    selectNav(state);
    expect(selectNav.recomputations()).toBe(1);
  });
});

describe('C08 nested mutation and shallowEqual', () => {
  it('nested mutation without changing references does not invalidate combiner cache (pin behavior)', () => {
    const state: NestedState = { inner: { value: 1 } };

    const selectInnerValue = createSelector(
      (s: NestedState) => s.inner,
      (inner) => inner.value,
    );

    expect(selectInnerValue(state)).toBe(1);
    expect(selectInnerValue.recomputations()).toBe(1);

    state.inner.value = 100;

    expect(selectInnerValue(state)).toBe(1);
    expect(selectInnerValue.recomputations()).toBe(1);
  });

  it('mutating a nested field with the same root state does not recompute combiner by state', () => {
    const state: NestedState = { inner: { value: 5 } };

    const selectViaRoot = createSelector(
      (s: NestedState) => s,
      (root) => root.inner.value,
    );

    expect(selectViaRoot(state)).toBe(5);
    expect(selectViaRoot.recomputations()).toBe(1);

    state.inner.value = 50;

    expect(selectViaRoot(state)).toBe(5);
    expect(selectViaRoot.recomputations()).toBe(1);
  });
});

describe('C06 createSelector — invalid and empty arguments', () => {
  it('C06: call with no arguments — TypeError on first select(state)', () => {
    // @ts-expect-error C06: intentionally call createSelector with no arguments
    const broken = createSelector();

    expect(() => {
      broken({ count: 1 });
    }).toThrow(TypeError);
  });

  it('C06: one argument (combiner only) — no input selectors, combiner called without deps', () => {
    // @ts-expect-error C06: combiner only, no input selectors
    const selectConstant = createSelector(() => 99);
    const state: CounterState = { count: 0 };

    expect(selectConstant(state)).toBe(99);
    expect(selectConstant.recomputations()).toBe(1);

    selectConstant(state);
    expect(selectConstant.recomputations()).toBe(1);
  });

  it('C06: empty input-selector array — combiner with no deps arguments', () => {
    const selectFromEmpty = createSelector([], () => 'empty-inputs');
    const state: CounterState = { count: 5 };

    expect(selectFromEmpty(state)).toBe('empty-inputs');
    expect(selectFromEmpty.recomputations()).toBe(1);
  });

  it('C06: last argument is not a function — TypeError on select(state)', () => {
    // @ts-expect-error C06: combiner is not a function
    const broken = createSelector(
      (s: CounterState) => s.count,
      'not-a-combiner',
    );

    expect(() => {
      broken({ count: 1 });
    }).toThrow(TypeError);
  });
});

describe('multi-input selectors, structured selector, and params memoization', () => {
  it('3 input selectors + combiner', () => {
    type Triple = { a: number; b: number; c: number };
    const state: Triple = { a: 2, b: 3, c: 4 };
    const selectSum = createSelector(
      (s: Triple) => {
        return s.a;
      },
      (s: Triple) => {
        return s.b;
      },
      (s: Triple) => {
        return s.c;
      },
      (a, b, c) => {
        return a + b + c;
      },
    );

    expect(selectSum(state)).toBe(9);
    expect(selectSum.recomputations()).toBe(1);
    expect(selectSum(state)).toBe(9);
    expect(selectSum.recomputations()).toBe(1);
  });

  it('createStructuredSelector does not recompute when fields are unchanged', () => {
    type NavState = { path: string; depth: number };
    let state: NavState = { path: '/a', depth: 1 };
    const selectNav = createStructuredSelector<
      NavState,
      { currentPath: string; level: number }
    >({
      currentPath: (s: NavState) => {
        return s.path;
      },
      level: (s: NavState) => {
        return s.depth;
      },
    });

    expect(selectNav(state)).toEqual({ currentPath: '/a', level: 1 });
    expect(selectNav.recomputations()).toBe(1);

    state = { path: '/a', depth: 1 };
    expect(selectNav(state)).toEqual({ currentPath: '/a', level: 1 });
    expect(selectNav.recomputations()).toBe(1);

    state = { path: '/b', depth: 1 };
    expect(selectNav(state)).toEqual({ currentPath: '/b', level: 1 });
    expect(selectNav.recomputations()).toBe(2);
  });

  it('shallowEqual of params array — same primitive deps without recompute', () => {
    type Pair = { a: number; b: number };
    const selectSum = createSelector(
      (s: Pair) => {
        return s.a;
      },
      (s: Pair) => {
        return s.b;
      },
      (a, b) => {
        return a + b;
      },
    );

    expect(selectSum({ a: 1, b: 2 })).toBe(3);
    expect(selectSum.recomputations()).toBe(1);

    expect(selectSum({ a: 1, b: 2 })).toBe(3);
    expect(selectSum.recomputations()).toBe(1);

    expect(selectSum({ a: 1, b: 3 })).toBe(4);
    expect(selectSum.recomputations()).toBe(2);
  });

  it('with the same deps combiner-object is memoized by reference', () => {
    const selectObj = createSelector(
      (s: CounterState) => {
        return s.count;
      },
      (count) => {
        return { doubled: count * 2 };
      },
    );

    const state: CounterState = { count: 3 };
    const first = selectObj(state);
    const second = selectObj(state);
    expect(first).toEqual({ doubled: 6 });
    expect(second).toBe(first);
    expect(selectObj.recomputations()).toBe(1);
  });
});
