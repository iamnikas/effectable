/**
 * createStore dispatch throughput (B11).
 * Run: npx jest createStore.benchmark --testTimeout=60000
 */

/* eslint-disable no-console */

import { benchAvgNs } from './helpers/effectableBenchmarkHelpers';
import { createStore } from 'Effectable';
import type { Action } from 'Effectable';

jest.setTimeout(60_000);

interface BenchState {
  n: number;
}

type BenchAction = Action<'INC'>;

/**
 * @param {BenchState} state
 * @param {BenchAction} action
 * @returns {BenchState}
 */
function reducer (state: BenchState, action: BenchAction): BenchState {
  if (action.type === 'INC') {
    return { n: state.n + 1 };
  }
  return state;
}

describe('Benchmark: createStore dispatch (B11)', () => {
  it('prints dispatch throughput for 10k–100k ops', () => {
    console.log('\n=== createStore dispatch ===');

    const store = createStore(reducer, { n: 0 });
    const action: BenchAction = { type: 'INC' };

    for (const iterations of [10_000, 100_000]) {
      const ns = benchAvgNs(
        () => {
          store.dispatch(action);
        },
        iterations,
        { warmupIterations: Math.min(1000, iterations / 10) },
      );
      console.log(`  dispatch ${String(iterations)}: ${ns.toFixed(2)} ns/op`);
      expect(ns).toBeGreaterThan(0);
      expect(Number.isFinite(ns)).toBe(true);
    }

    store.destroy();
  });
});
