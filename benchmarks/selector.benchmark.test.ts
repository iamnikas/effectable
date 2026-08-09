/**
 * createSelector hit/miss cost (C07).
 * Run: npx jest selector.benchmark --testTimeout=60000
 */

/* eslint-disable no-console */

import { benchAvgNs } from './helpers/effectableBenchmarkHelpers';
import { createSelector } from 'Effectable';

jest.setTimeout(60_000);

interface BenchState {
  a: number;
  b: number;
}

describe('Benchmark: createSelector hit/miss (C07)', () => {
  it('prints cache hit vs miss ns/op', () => {
    console.log('\n=== createSelector hit/miss ===');

    const selectSum = createSelector(
      (s: BenchState) => s.a,
      (s: BenchState) => s.b,
      (a: number, b: number) => a + b,
    );

    const stable: BenchState = { a: 1, b: 2 };
    selectSum(stable);

    const hitNs = benchAvgNs(
      () => {
        selectSum(stable);
      },
      100_000,
      { warmupIterations: 5_000 },
    );

    let i = 0;
    const missNs = benchAvgNs(
      () => {
        i += 1;
        selectSum({ a: i, b: i + 1 });
      },
      100_000,
      { warmupIterations: 5_000 },
    );

    console.log(`  cache hit: ${hitNs.toFixed(2)} ns/op`);
    console.log(`  cache miss: ${missNs.toFixed(2)} ns/op`);
    console.log(`  miss/hit ratio: ${(missNs / hitNs).toFixed(2)}x`);

    expect(hitNs).toBeGreaterThan(0);
    expect(missNs).toBeGreaterThan(0);
    expect(Number.isFinite(hitNs)).toBe(true);
    expect(Number.isFinite(missNs)).toBe(true);
    expect(missNs).toBeGreaterThan(hitNs * 0.5);
  });
});
