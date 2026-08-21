/**
 * Benchmarks of h() overloads and fast-path factory.
 * Run: npx jest h.benchmark --testTimeout=120000
 */
/* eslint-disable no-console */

import { benchAvgNs } from './helpers/effectableBenchmarkHelpers';
import { Component, h } from 'Effectable';
import type { RefObject, VirtualServiceNode } from 'Effectable';

const ITERATIONS = 50_000;

interface BenchProps {
  id: string;
  label?: string;
}

class HLeafComponent extends Component<Record<string, never>, BenchProps> {
  constructor (props: BenchProps) {
    super(props);
    this.state = {};
  }
}

class HParentComponent extends Component<Record<string, never>, BenchProps> {
  constructor (props: BenchProps) {
    super(props);
    this.state = {};
  }
}

function createLeafRef (): RefObject<HLeafComponent> {
  return { current: null };
}

function createParentRef (): RefObject<HParentComponent> {
  return { current: null };
}

describe('Benchmark: h fast-path', () => {
  it('prints cost of a bare h(type, props) call', () => {
    console.log('\n=== h(type, props) ===');

    const ns = benchAvgNs(
      () => {
        void h(HLeafComponent, { id: 'leaf' });
      },
      ITERATIONS,
      { warmupIterations: 2000 }
    );

    console.log(`  bare h(type, props): ${ns.toFixed(2)} ns/op`);

    expect(ns).toBeGreaterThan(0);
    expect(Number.isFinite(ns)).toBe(true);
  });
});

describe('Benchmark: h overload matrix', () => {
  const childNodes: VirtualServiceNode[] = [
    h(HLeafComponent, { id: 'child-1', label: 'a' }),
    h(HLeafComponent, { id: 'child-2', label: 'b' }),
  ];

  it('compares key-only, ref-only, and full overload with children', () => {
    console.log('\n=== h overload matrix ===');

    const keyOnlyNs = benchAvgNs(
      () => {
        void h(HLeafComponent, { id: 'key-only' }, 'bench-key');
      },
      ITERATIONS,
      { warmupIterations: 2000 }
    );

    const refOnlyNs = benchAvgNs(
      () => {
        void h(HLeafComponent, { id: 'ref-only' }, createLeafRef());
      },
      ITERATIONS,
      { warmupIterations: 2000 }
    );

    const childrenOnlyNs = benchAvgNs(
      () => {
        void h(HParentComponent, { id: 'children-only' }, childNodes);
      },
      ITERATIONS,
      { warmupIterations: 2000 }
    );

    const fullOverloadNs = benchAvgNs(
      () => {
        void h(
          HParentComponent,
          { id: 'full-overload', label: 'full' },
          createParentRef(),
          childNodes,
          'full-key'
        );
      },
      ITERATIONS,
      { warmupIterations: 2000 }
    );

    console.log(`  key only: ${keyOnlyNs.toFixed(2)} ns/op`);
    console.log(`  ref only: ${refOnlyNs.toFixed(2)} ns/op`);
    console.log(`  children only: ${childrenOnlyNs.toFixed(2)} ns/op`);
    console.log(`  ref + children + key: ${fullOverloadNs.toFixed(2)} ns/op`);

    expect(keyOnlyNs).toBeGreaterThan(0);
    expect(refOnlyNs).toBeGreaterThan(0);
    expect(childrenOnlyNs).toBeGreaterThan(0);
    expect(fullOverloadNs).toBeGreaterThan(0);
    expect(Number.isFinite(keyOnlyNs)).toBe(true);
    expect(Number.isFinite(refOnlyNs)).toBe(true);
    expect(Number.isFinite(childrenOnlyNs)).toBe(true);
    expect(Number.isFinite(fullOverloadNs)).toBe(true);
  });
});

jest.setTimeout(120_000);
