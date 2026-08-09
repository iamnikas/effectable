/**
 * Benchmark of startup time and warmup for the Component-based bootstrap path.
 * Run: npx jest bootstrap.benchmark --testTimeout=120000
 */

/* eslint-disable no-console */

import { benchAvgNs, measureOnceNs } from './helpers/effectableBenchmarkHelpers';
import { Component, bootstrap } from 'Effectable';

interface BenchProps {
  tag: string;
}

class BenchRoot extends Component<Record<string, never>, BenchProps> {
  constructor (props: BenchProps) {
    super(props);
  }

  public override compose (): null {
    return null;
  }
}

describe('bootstrap — cold start and warmup', () => {
  it('measures the first successful bootstrap (startup time)', async () => {
    const t0 = process.hrtime.bigint();
    const handle = await bootstrap<BenchProps, BenchRoot>(BenchRoot, { tag: 'a' }, {
      name: 'bench-cold',
    });
    const t1 = process.hrtime.bigint();
    const ns = Number(t1 - t0);

    expect(handle.isRunning()).toBe(true);
    console.log(`  first bootstrap (cold): ${(ns / 1e6).toFixed(3)} ms wall`);
    expect(ns).toBeGreaterThan(0);

    await handle.shutdown();
  });

  it('repeated bootstrap after warmup: average wall-clock time', async () => {
    const runs = 12;
    const samplesMs: number[] = [];

    for (let i = 0; i < runs; i++) {
      const t0 = process.hrtime.bigint();
      const handle = await bootstrap<BenchProps, BenchRoot>(BenchRoot, { tag: 'w' }, {
        name: `bench-warm-${i}`,
      });
      const t1 = process.hrtime.bigint();
      samplesMs.push(Number(t1 - t0) / 1e6);
      await handle.shutdown();
    }

    const avg = samplesMs.reduce((a, b) => a + b, 0) / samplesMs.length;
    console.log(`  average of ${runs} runs: ${avg.toFixed(3)} ms wall`);
    expect(avg).toBeGreaterThan(0);
    expect(avg).toBeLessThan(samplesMs[0]! * 20);
  });

  it('synchronous measurement of createRuntime body only (micro)', () => {
    const t = measureOnceNs(() => {
      const ctx = { name: 'x', props: { tag: 'm' } };
      void ctx;
    });
    console.log(`  measureOnceNs of empty block: ${t} ns`);
    expect(Number(t)).toBeGreaterThanOrEqual(0);
  });

  it('avalanche of empty ops after simulating heavy deps', () => {
    const heavy = Array.from({ length: 50_000 }, (_, i) => i);
    const scales = [0, 1, 100, 5000, 50_000];

    for (const take of scales) {
      const slice = heavy.slice(0, take);
      const t = benchAvgNs(
        () => {
          let s = 0;
          for (const v of slice) s += v;
          void s;
        },
        30,
        { warmupIterations: 5 },
      );
      console.log(`  slice len=${take}: ${t.toFixed(0)} ns/op (outer)`);
      expect(t).toBeGreaterThan(0);
    }
  });

  it('second cold bootstrap with a different name yields positive wall time', async () => {
    const t0 = process.hrtime.bigint();
    const handle = await bootstrap<BenchProps, BenchRoot>(BenchRoot, { tag: 'alt' }, {
      name: 'bench-cold-alt',
    });
    const t1 = process.hrtime.bigint();
    const ns = Number(t1 - t0);

    expect(handle.isRunning()).toBe(true);
    expect(ns).toBeGreaterThan(0);
    console.log(`  alternate cold bootstrap: ${(ns / 1e6).toFixed(3)} ms wall`);

    await handle.shutdown();
  });
});

jest.setTimeout(120_000);
