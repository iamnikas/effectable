/**
 * E08: buildSemanticStateTree on wide and deep state completes and returns kind.
 */

import { buildSemanticStateTree } from 'Effectable';

jest.setTimeout(120_000);

function buildWideState (keyCount: number): Record<string, number> {
  const state: Record<string, number> = {};

  for (let index = 0; index < keyCount; index += 1) {
    state[`k${String(index)}`] = index;
  }

  return state;
}

function buildDeepState (depth: number): Record<string, unknown> {
  let nested: Record<string, unknown> = { leaf: true };

  for (let level = 0; level < depth; level += 1) {
    nested = { nested };
  }

  return nested;
}

describe('semanticStateTree — resilience E08', () => {
  it('completes for an object with 10_000 keys and returns a node with kind', () => {
    const tree = buildSemanticStateTree(buildWideState(10_000), {
      maxKeysPerObject: 10_000,
    });

    expect(typeof tree.kind).toBe('string');
    expect(tree.kind).toBe('object');

    if (tree.kind !== 'object') {
      throw new Error('expected object root kind');
    }

    expect(Object.keys(tree.keys).length).toBe(10_000);
  });

  it('completes for a deeply nested object and returns a node with kind', () => {
    const tree = buildSemanticStateTree(buildDeepState(64), {
      maxDepth: 128,
    });

    expect(typeof tree.kind).toBe('string');
    expect(tree.kind).toBe('object');

    if (tree.kind !== 'object') {
      throw new Error('expected object root kind');
    }

    expect(tree.keys['nested']).toBeDefined();
  });
});
