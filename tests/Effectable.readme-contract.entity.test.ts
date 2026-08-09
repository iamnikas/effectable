/**
 * Public API contract for [`Effectable/index.ts`](index.ts) as described in the README.
 *
 * @module Effectable/tests/Effectable.readme-contract.entity.test
 */

import * as Effectable from 'Effectable';

describe('Effectable public API (README contract)', () => {
  it('exports bootstrap and it is a function', () => {
    expect(typeof Effectable.bootstrap).toBe('function');
  });

  it('BOOT-41: exports BOOTSTRAP_RUNTIME_NODE_KIND and BOOTSTRAP_RUNTIME_NODE_OWNERSHIP', () => {
    expect(Effectable.BOOTSTRAP_RUNTIME_NODE_KIND).toEqual({
      ROOT: 'ROOT',
      MOLECULE: 'MOLECULE',
    });
    expect(Effectable.BOOTSTRAP_RUNTIME_NODE_OWNERSHIP).toEqual({
      RUNTIME_OWNED: 'RUNTIME_OWNED',
      COMPATIBILITY_BRIDGE: 'COMPATIBILITY_BRIDGE',
    });
  });

  it('exports store API — createStore, compose, applyMiddleware, createSelector, SST', () => {
    expect(typeof Effectable.createStore).toBe('function');
    expect(typeof Effectable.compose).toBe('function');
    expect(typeof Effectable.applyMiddleware).toBe('function');
    expect(typeof Effectable.createSelector).toBe('function');
    expect(typeof Effectable.createStructuredSelector).toBe('function');
    expect(typeof Effectable.buildSemanticStateTree).toBe('function');
    expect(typeof Effectable.semanticStateTreeToJsonString).toBe('function');
  });

  it('exports component primitives: Component, h, GraphRuntime, LifecycleEngine', () => {
    expect(typeof Effectable.Component).toBe('function');
    expect(typeof Effectable.h).toBe('function');
    expect(typeof Effectable.GraphRuntime).toBe('function');
    expect(typeof Effectable.LifecycleEngine).toBe('function');
  });

  it('exports FIBER_EFFECT_TAG and makeFiberEffectTag as FiberEffectTag identity helper', () => {
    expect(Effectable.FIBER_EFFECT_TAG).toEqual({
      PLACE: 'PLACE',
      UPDATE: 'UPDATE',
      DELETE: 'DELETE',
    });
    expect(typeof Effectable.makeFiberEffectTag).toBe('function');
    expect(Effectable.makeFiberEffectTag(Effectable.FIBER_EFFECT_TAG.PLACE)).toBe(
      Effectable.FIBER_EFFECT_TAG.PLACE,
    );
    expect(Effectable.makeFiberEffectTag(Effectable.FIBER_EFFECT_TAG.UPDATE)).toBe(
      Effectable.FIBER_EFFECT_TAG.UPDATE,
    );
    expect(Effectable.makeFiberEffectTag(Effectable.FIBER_EFFECT_TAG.DELETE)).toBe(
      Effectable.FIBER_EFFECT_TAG.DELETE,
    );
    expect(Effectable.makeFiberEffectTag(null)).toBe(null);
  });

  it('exports connect', () => {
    expect(typeof Effectable.connect).toBe('function');
  });

  it('exports runtime primitives and HandleRegistry aliases to resolve name conflicts', () => {
    expect(typeof Effectable.EventBus).toBe('function');
    expect(typeof Effectable.CommandBus).toBe('function');
    expect(typeof Effectable.QueryBus).toBe('function');
    expect(typeof Effectable.HandleRegistry).toBe('function');
    expect(typeof Effectable.HandleRegistryUseRef).toBe('function');
    expect(typeof Effectable.HandleRegistryUseImperativeHandle).toBe('function');
  });

  it('does not replace expected export names with empty values', () => {
    expect(Effectable.bootstrap).not.toBeUndefined();
    expect(Effectable.createStore).not.toBeUndefined();
    expect(Effectable.Component).not.toBeUndefined();
    expect(Effectable.HandleRegistryUseRef).not.toBeUndefined();
  });

  it('O02: component UseRef and HandleRegistryUseRef are different functions (GraphRuntime vs HandleRegistry)', () => {
    expect(typeof Effectable.UseRef).toBe('function');
    expect(typeof Effectable.HandleRegistryUseRef).toBe('function');
    expect(Effectable.UseRef).not.toBe(Effectable.HandleRegistryUseRef);
    expect(typeof Effectable.UseImperativeHandle).toBe('function');
    expect(typeof Effectable.HandleRegistryUseImperativeHandle).toBe('function');
    expect(Effectable.UseImperativeHandle).not.toBe(Effectable.HandleRegistryUseImperativeHandle);
  });
});

