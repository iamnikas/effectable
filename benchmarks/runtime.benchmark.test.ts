/**
 * Benchmarks of runtime primitives: buses, decorator wiring, and HandleRegistry.
 * Run: npx jest runtime.benchmark --testTimeout=120000
 */
/* eslint-disable no-console */

import { benchAvgNs } from './helpers/effectableBenchmarkHelpers';
import {
  CommandBus,
  EventBus,
  HandleRegistryUseImperativeHandle,
  HandleRegistryUseRef,
  HandleRegistry,
  OnCommand,
  OnEvent,
  OnQuery,
  QueryBus,
  UseCommandBus,
  UseEventBus,
  UseQueryBus,
  createRuntimeBuses,
  forwardRef,
  wireRuntimeBusesIfDecorated,
} from 'Effectable';
import type { RuntimeCommand, RuntimeEvent, RuntimeQuery } from 'Effectable';

const ITERATIONS = 10_000;

type BenchCommand = RuntimeCommand<'BENCH_COMMAND', { value: number }>;
type BenchQuery = RuntimeQuery<'BENCH_QUERY', { value: number }>;
type BenchEvent = RuntimeEvent<'BENCH_EVENT', { value: number }>;
type DynamicBenchCommand = RuntimeCommand<string, { value: number }>;

async function benchAvgAsyncNs (
  fn: () => Promise<void>,
  iterations: number,
  options?: { warmupIterations?: number },
): Promise<number> {
  const warmup = options?.warmupIterations ?? Math.min(500, Math.max(1, Math.floor(iterations / 10)));

  for (let i = 0; i < warmup; i += 1) {
    await fn();
  }

  const start = process.hrtime.bigint();
  for (let i = 0; i < iterations; i += 1) {
    await fn();
  }
  const end = process.hrtime.bigint();

  return Number(end - start) / iterations;
}

class DecoratedRuntimeTarget {
  @UseCommandBus()
  public commandBus?: CommandBus<BenchCommand>;

  @UseQueryBus()
  public queryBus?: QueryBus<BenchQuery>;

  @UseEventBus()
  public eventBus?: EventBus<BenchEvent>;

  public handledCommands = 0;
  public handledQueries = 0;
  public handledEvents = 0;

  @OnCommand('BENCH_COMMAND')
  public async handleCommand (command: BenchCommand): Promise<number> {
    this.handledCommands += command.payload.value;
    return this.handledCommands;
  }

  @OnQuery('BENCH_QUERY')
  public handleQuery (query: BenchQuery): number {
    this.handledQueries += query.payload.value;
    return this.handledQueries;
  }

  @OnEvent('BENCH_EVENT')
  public handleEvent (event: BenchEvent): void {
    this.handledEvents += event.payload.value;
  }
}

@forwardRef<RegistryHandleHost>((instance) => {
  return instance.handleKey;
})
class RegistryHandleHost {
  @HandleRegistryUseRef()
  public handle: Record<string, unknown> = {};

  public readonly handleKey: string;
  private value = 0;

  constructor (handleKey: string) {
    this.handleKey = handleKey;
  }

  @HandleRegistryUseImperativeHandle()
  public inc (): number {
    this.value += 1;
    return this.value;
  }

  @HandleRegistryUseImperativeHandle()
  public read (): number {
    return this.value;
  }
}

describe('Benchmark: EventBus publish fan-out', () => {
  it('prints publish for typed handlers and subscribeAll', () => {
    console.log('\n=== EventBus publish fan-out ===');

    const singleBus = new EventBus<BenchEvent>();
    let singleHits = 0;
    singleBus.subscribe('BENCH_EVENT', () => {
      singleHits += 1;
    });

    const singleNs = benchAvgNs(
      () => {
        singleBus.publish({ type: 'BENCH_EVENT', payload: { value: 1 } });
      },
      ITERATIONS,
      { warmupIterations: 500 }
    );

    const fanOutBus = new EventBus<BenchEvent>();
    let fanOutHits = 0;
    for (let i = 0; i < 64; i += 1) {
      fanOutBus.subscribe('BENCH_EVENT', () => {
        fanOutHits += 1;
      });
    }
    fanOutBus.subscribeAll(() => {
      fanOutHits += 1;
    });

    const fanOutNs = benchAvgNs(
      () => {
        fanOutBus.publish({ type: 'BENCH_EVENT', payload: { value: 1 } });
      },
      ITERATIONS,
      { warmupIterations: 500 }
    );

    console.log(`  single handler publish: ${singleNs.toFixed(2)} ns/op`);
    console.log(`  64 typed + 1 any handler publish: ${fanOutNs.toFixed(2)} ns/op`);

    expect(singleNs).toBeGreaterThan(0);
    expect(fanOutNs).toBeGreaterThan(0);
    expect(Number.isFinite(singleNs)).toBe(true);
    expect(Number.isFinite(fanOutNs)).toBe(true);
    expect(singleHits).toBe(ITERATIONS + 500);
    expect(fanOutHits).toBe((ITERATIONS + 500) * 65);
  });

  it('prints publish with 10k typed subscribers (M09)', () => {
    console.log('\n=== EventBus 10k subscribers publish ===');

    const bus = new EventBus<BenchEvent>();
    let hits = 0;
    for (let i = 0; i < 10_000; i += 1) {
      bus.subscribe('BENCH_EVENT', () => {
        hits += 1;
      });
    }

    const iterations = 200;
    const warmup = 20;
    const ns = benchAvgNs(
      () => {
        bus.publish({ type: 'BENCH_EVENT', payload: { value: 1 } });
      },
      iterations,
      { warmupIterations: warmup },
    );

    console.log(`  10k subscribers publish: ${ns.toFixed(2)} ns/op`);
    expect(ns).toBeGreaterThan(0);
    expect(Number.isFinite(ns)).toBe(true);
    expect(hits).toBe((iterations + warmup) * 10_000);
  });
});

describe('Benchmark: CommandBus and QueryBus execute', () => {
  it('prints execute hot-path for CommandBus', async () => {
    console.log('\n=== CommandBus execute ===');

    const bus = new CommandBus<BenchCommand>();
    const dispose = bus.register('BENCH_COMMAND', async (command) => {
      return command.payload.value + 1;
    });

    const ns = await benchAvgAsyncNs(
      async () => {
        await bus.execute<number>({ type: 'BENCH_COMMAND', payload: { value: 1 } });
      },
      ITERATIONS,
      { warmupIterations: 500 }
    );

    console.log(`  command execute: ${ns.toFixed(2)} ns/op`);

    expect(ns).toBeGreaterThan(0);
    expect(Number.isFinite(ns)).toBe(true);

    dispose();
  });

  it('prints execute hot-path for QueryBus', async () => {
    console.log('\n=== QueryBus execute ===');

    const bus = new QueryBus<BenchQuery>();
    const dispose = bus.register('BENCH_QUERY', async (query) => {
      return query.payload.value + 1;
    });

    const ns = await benchAvgAsyncNs(
      async () => {
        await bus.execute<number>({ type: 'BENCH_QUERY', payload: { value: 1 } });
      },
      ITERATIONS,
      { warmupIterations: 500 }
    );

    console.log(`  query execute: ${ns.toFixed(2)} ns/op`);

    expect(ns).toBeGreaterThan(0);
    expect(Number.isFinite(ns)).toBe(true);

    dispose();
  });

  it('prints register/unregister churn for CommandBus', () => {
    console.log('\n=== CommandBus register/unregister churn ===');

    const bus = new CommandBus<DynamicBenchCommand>();
    let sequence = 0;

    const ns = benchAvgNs(
      () => {
        const type = `CMD_${String(sequence)}`;
        sequence += 1;
        const dispose = bus.register(type, async (command) => {
          return command.payload.value;
        });
        dispose();
      },
      5_000,
      { warmupIterations: 200 }
    );

    console.log(`  register/unregister churn: ${ns.toFixed(2)} ns/op`);

    expect(ns).toBeGreaterThan(0);
    expect(Number.isFinite(ns)).toBe(true);
  });
});

describe('Benchmark: BusDecorators wiring', () => {
  it('prints wireRuntimeBusesIfDecorated + disposer churn', () => {
    console.log('\n=== wireRuntimeBusesIfDecorated churn ===');

    const ns = benchAvgNs(
      () => {
        const buses = createRuntimeBuses<BenchCommand, BenchQuery, BenchEvent>();
        const instance = new DecoratedRuntimeTarget();
        const dispose = wireRuntimeBusesIfDecorated(instance, buses);

        if (dispose === null) {
          throw new Error('Expected runtime bus wiring for decorated instance');
        }

        dispose();
      },
      3_000,
      { warmupIterations: 200 }
    );

    console.log(`  wire + dispose: ${ns.toFixed(2)} ns/op`);

    expect(ns).toBeGreaterThan(0);
    expect(Number.isFinite(ns)).toBe(true);
  });

  it('prints wiring + dispatch/query/event through real decorators', async () => {
    console.log('\n=== decorators wired execute/publish ===');

    const buses = createRuntimeBuses<BenchCommand, BenchQuery, BenchEvent>();
    const instance = new DecoratedRuntimeTarget();
    const dispose = wireRuntimeBusesIfDecorated(instance, buses);

    if (dispose === null) {
      throw new Error('Expected runtime bus wiring for decorated instance');
    }

    const ns = await benchAvgAsyncNs(
      async () => {
        await buses.commandBus.execute<number>({
          type: 'BENCH_COMMAND',
          payload: { value: 1 },
        });
        await buses.queryBus.execute<number>({
          type: 'BENCH_QUERY',
          payload: { value: 1 },
        });
        buses.eventBus.publish({
          type: 'BENCH_EVENT',
          payload: { value: 1 },
        });
      },
      4_000,
      { warmupIterations: 200 }
    );

    console.log(`  wired execute/publish trio: ${ns.toFixed(2)} ns/op`);

    expect(ns).toBeGreaterThan(0);
    expect(Number.isFinite(ns)).toBe(true);

    dispose();
  });
});

describe('Benchmark: HandleRegistry autoRegister', () => {
  it('prints autoRegister + resolve + dispose', () => {
    console.log('\n=== HandleRegistry autoRegister ===');

    const ns = benchAvgNs(
      () => {
        const registry = new HandleRegistry();
        const host = new RegistryHandleHost('handle-single');
        const dispose = registry.autoRegister(host);
        const handle = registry.resolve<Record<string, unknown>>('handle-single');
        const inc = handle['inc'];
        if (typeof inc !== 'function') {
          throw new Error('Expected imperative handle method');
        }
        inc();
        dispose();
      },
      3_000,
      { warmupIterations: 200 }
    );

    console.log(`  autoRegister + resolve + dispose: ${ns.toFixed(2)} ns/op`);

    expect(ns).toBeGreaterThan(0);
    expect(Number.isFinite(ns)).toBe(true);
  });

  it('prints scaling across many handle keys', () => {
    console.log('\n=== HandleRegistry key scaling ===');

    for (const count of [1, 16, 64]) {
      const ns = benchAvgNs(
        () => {
          const registry = new HandleRegistry();
          const disposers: Array<() => void> = [];

          for (let i = 0; i < count; i += 1) {
            const host = new RegistryHandleHost(`handle-${String(i)}`);
            disposers.push(registry.autoRegister(host));
          }

          for (let i = 0; i < count; i += 1) {
            const handle = registry.resolve<Record<string, unknown>>(`handle-${String(i)}`);
            const read = handle['read'];
            if (typeof read !== 'function') {
              throw new Error('Expected imperative read method');
            }
            read();
          }

          for (let i = disposers.length - 1; i >= 0; i -= 1) {
            disposers[i]();
          }
        },
        800,
        { warmupIterations: 80 }
      );

      console.log(`  handle count=${String(count)}: ${ns.toFixed(2)} ns/op`);
      expect(ns).toBeGreaterThan(0);
      expect(Number.isFinite(ns)).toBe(true);
    }
  });
});

jest.setTimeout(120_000);
