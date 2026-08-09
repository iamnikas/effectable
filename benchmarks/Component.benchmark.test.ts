/**
 * Benchmarks of Component.setState hot paths.
 * Run: npx jest Component.benchmark --testTimeout=120000
 */
/* eslint-disable no-console */

import { benchAvgNs, coldVsWarm } from './helpers/effectableBenchmarkHelpers';
import { Component } from 'Effectable';

const ITERATIONS = 25_000;
const WIDE_STATE_KEYS = 64;

interface SmallState {
  count: number;
  version: number;
}

interface WideState {
  count: number;
  version: number;
  k00: number;
  k01: number;
  k02: number;
  k03: number;
  k04: number;
  k05: number;
  k06: number;
  k07: number;
  k08: number;
  k09: number;
  k10: number;
  k11: number;
  k12: number;
  k13: number;
  k14: number;
  k15: number;
  k16: number;
  k17: number;
  k18: number;
  k19: number;
  k20: number;
  k21: number;
  k22: number;
  k23: number;
  k24: number;
  k25: number;
  k26: number;
  k27: number;
  k28: number;
  k29: number;
  k30: number;
  k31: number;
  k32: number;
  k33: number;
  k34: number;
  k35: number;
  k36: number;
  k37: number;
  k38: number;
  k39: number;
  k40: number;
  k41: number;
  k42: number;
  k43: number;
  k44: number;
  k45: number;
  k46: number;
  k47: number;
  k48: number;
  k49: number;
  k50: number;
  k51: number;
  k52: number;
  k53: number;
  k54: number;
  k55: number;
  k56: number;
  k57: number;
  k58: number;
  k59: number;
  k60: number;
  k61: number;
  k62: number;
  k63: number;
}

class ImmutableSmallComponent extends Component<SmallState, Record<string, never>> {
  constructor () {
    super({});
    this.state = {
      count: 0,
      version: 0,
    };
  }
}

class MutableSmallComponent extends Component<SmallState, Record<string, never>> {
  public static override readonly mutableState = true;

  constructor () {
    super({});
    this.state = {
      count: 0,
      version: 0,
    };
  }
}

class ImmutableWideComponent extends Component<WideState, Record<string, never>> {
  constructor () {
    super({});
    this.state = createWideState();
  }
}

class MutableWideComponent extends Component<WideState, Record<string, never>> {
  public static override readonly mutableState = true;

  constructor () {
    super({});
    this.state = createWideState();
  }
}

function createWideState (): WideState {
  return {
    count: 0,
    version: 0,
    k00: 0,
    k01: 1,
    k02: 2,
    k03: 3,
    k04: 4,
    k05: 5,
    k06: 6,
    k07: 7,
    k08: 8,
    k09: 9,
    k10: 10,
    k11: 11,
    k12: 12,
    k13: 13,
    k14: 14,
    k15: 15,
    k16: 16,
    k17: 17,
    k18: 18,
    k19: 19,
    k20: 20,
    k21: 21,
    k22: 22,
    k23: 23,
    k24: 24,
    k25: 25,
    k26: 26,
    k27: 27,
    k28: 28,
    k29: 29,
    k30: 30,
    k31: 31,
    k32: 32,
    k33: 33,
    k34: 34,
    k35: 35,
    k36: 36,
    k37: 37,
    k38: 38,
    k39: 39,
    k40: 40,
    k41: 41,
    k42: 42,
    k43: 43,
    k44: 44,
    k45: 45,
    k46: 46,
    k47: 47,
    k48: 48,
    k49: 49,
    k50: 50,
    k51: 51,
    k52: 52,
    k53: 53,
    k54: 54,
    k55: 55,
    k56: 56,
    k57: 57,
    k58: 58,
    k59: 59,
    k60: 60,
    k61: 61,
    k62: 62,
    k63: 63,
  };
}

describe('Benchmark: Component.setState object update', () => {
  it('prints mutableState vs immutable merge on small state', () => {
    console.log('\n=== Component.setState small state ===');

    const immutable = new ImmutableSmallComponent();
    const mutable = new MutableSmallComponent();

    const immutableNs = benchAvgNs(
      () => {
        immutable.setState({
          count: immutable.state.count + 1,
        });
      },
      ITERATIONS,
      { warmupIterations: 1000 }
    );

    const mutableNs = benchAvgNs(
      () => {
        mutable.setState({
          count: mutable.state.count + 1,
        });
      },
      ITERATIONS,
      { warmupIterations: 1000 }
    );

    const speedup = immutableNs / mutableNs;

    console.log(`  immutable small state: ${immutableNs.toFixed(2)} ns/op`);
    console.log(`  mutable small state: ${mutableNs.toFixed(2)} ns/op`);
    console.log(`  mutable speedup: ${speedup.toFixed(2)}x`);

    expect(immutableNs).toBeGreaterThan(0);
    expect(mutableNs).toBeGreaterThan(0);
    expect(Number.isFinite(immutableNs)).toBe(true);
    expect(Number.isFinite(mutableNs)).toBe(true);
    expect(speedup).toBeGreaterThan(0.7);
  });

  it('prints mutableState vs immutable merge on wide state', () => {
    console.log('\n=== Component.setState wide state ===');

    const immutable = new ImmutableWideComponent();
    const mutable = new MutableWideComponent();

    const immutableNs = benchAvgNs(
      () => {
        immutable.setState({
          count: immutable.state.count + 1,
          version: immutable.state.version + 1,
        });
      },
      ITERATIONS,
      { warmupIterations: 1000 }
    );

    const mutableNs = benchAvgNs(
      () => {
        mutable.setState({
          count: mutable.state.count + 1,
          version: mutable.state.version + 1,
        });
      },
      ITERATIONS,
      { warmupIterations: 1000 }
    );

    const speedup = immutableNs / mutableNs;

    console.log(`  wide state keys: ${String(WIDE_STATE_KEYS + 2)}`);
    console.log(`  immutable wide state: ${immutableNs.toFixed(2)} ns/op`);
    console.log(`  mutable wide state: ${mutableNs.toFixed(2)} ns/op`);
    console.log(`  mutable speedup: ${speedup.toFixed(2)}x`);

    expect(immutableNs).toBeGreaterThan(0);
    expect(mutableNs).toBeGreaterThan(0);
    expect(Number.isFinite(immutableNs)).toBe(true);
    expect(Number.isFinite(mutableNs)).toBe(true);
    expect(speedup).toBeGreaterThan(1.0);
  });
});

describe('Benchmark: Component.setState function updater', () => {
  it('prints cold vs warm for function updater on an immutable component', () => {
    console.log('\n=== Component.setState function updater cold vs warm ===');

    const instance = new ImmutableWideComponent();
    const result = coldVsWarm(
      () => {
        instance.setState((prev) => ({
          count: prev.count + 1,
          version: prev.version + 1,
        }));
      },
      10_000
    );

    console.log(`  cold first update: ${result.coldNsPerOp.toFixed(0)} ns`);
    console.log(`  warm avg update: ${result.warmNsPerOp.toFixed(2)} ns/op`);

    expect(result.coldNsPerOp).toBeGreaterThan(0);
    expect(result.warmNsPerOp).toBeGreaterThan(0);
    expect(Number.isFinite(result.coldNsPerOp)).toBe(true);
    expect(Number.isFinite(result.warmNsPerOp)).toBe(true);
  });
});

jest.setTimeout(120_000);
