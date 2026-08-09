/**
 * Helpers for Effectable Jest benchmarks (warmup, cold start, N grids).
 */

/**
 * Measures a single call in nanoseconds (bigint hrtime).
 */
export function measureOnceNs (fn: () => void): bigint {
  const start = process.hrtime.bigint();
  fn();
  return process.hrtime.bigint() - start;
}

/**
 * Average time per iteration (ns/op) with optional warmup.
 */
export function benchAvgNs (
  fn: () => void,
  iterations: number,
  options?: { warmupIterations?: number },
): number {
  const warmup = options?.warmupIterations ?? Math.min(1000, Math.max(1, Math.floor(iterations / 10)));
  for (let i = 0; i < warmup; i++) {
    fn();
  }
  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    fn();
  }
  const end = process.hrtime.bigint();
  return Number(end - start) / iterations;
}

/**
 * First measurement without warmup and average after warmup (both ns/op).
 */
export function coldVsWarm (
  fn: () => void,
  iterations: number,
): { coldNsPerOp: number; warmNsPerOp: number } {
  const coldStart = process.hrtime.bigint();
  fn();
  const coldEnd = process.hrtime.bigint();
  const coldNsPerOp = Number(coldEnd - coldStart);

  const warm = benchAvgNs(fn, iterations, { warmupIterations: Math.min(2000, iterations) });
  return { coldNsPerOp, warmNsPerOp: warm };
}
