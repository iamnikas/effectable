/**
 * Tests for centralized ref ownership (issue #17).
 * 
 * Verifies that:
 * - Old refs are cleared when removed or swapped
 * - Failed mount does not leak bound refs
 * - Keyed reuse with changed ref works correctly
 * - Symbol-based decorator storage prevents collisions
 * 
 * @module Effectable/component/GraphRuntime.ref-ownership.test
 */

import { Component, GraphRuntime, h, UseRef } from 'Effectable';
import type { RefObject, VirtualServiceNode } from 'Effectable';

class Child extends Component<Record<string, never>, { id: string }> {
  public value = 42;
  
  constructor (props: { id: string }) {
    super(props);
    this.state = {};
  }
}

class FailingChild extends Component<Record<string, never>, { shouldFail?: boolean }> {
  public value = 99;
  
  public override async onMount (): Promise<void> {
    if (this.props.shouldFail === true) {
      throw new Error('FailingChild onMount error');
    }
  }
}

describe('GraphRuntime ref ownership (issue #17)', () => {
  describe('REF-ADD-REMOVE-REPLACE: ref add/remove/replace', () => {
    class ParentWithDynamicRef extends Component<Record<string, never>, { hasRef: boolean; refId: number }> {
      public ref1: RefObject<Child> = { current: null };
      public ref2: RefObject<Child> = { current: null };

      public override compose (): VirtualServiceNode[] {
        if (!this.props.hasRef) {
          return [h(Child, { id: 'child' })];
        }

        const ref = this.props.refId === 1 ? this.ref1 : this.ref2;
        return [h(Child, { id: 'child' }, ref)];
      }
    }

    it('REF-ADD: adding a ref binds it to the child instance', async () => {
      const runtime = await GraphRuntime.mount(h(ParentWithDynamicRef, { hasRef: false, refId: 1 }));
      const parent = runtime.getRootInstance() as ParentWithDynamicRef | null;
      expect(parent).not.toBeNull();
      if (parent === null) {
        throw new Error('expected ParentWithDynamicRef');
      }

      // Initially no ref
      expect(parent.ref1.current).toBeNull();

      // Add ref
      await runtime.reconcile(h(ParentWithDynamicRef, { hasRef: true, refId: 1 }));

      expect(parent.ref1.current).toBeInstanceOf(Child);
      expect(parent.ref1.current?.props.id).toBe('child');

      await runtime.unmount();
    });

    it('REF-REMOVE: removing a ref clears it', async () => {
      const runtime = await GraphRuntime.mount(h(ParentWithDynamicRef, { hasRef: true, refId: 1 }));
      const parent = runtime.getRootInstance() as ParentWithDynamicRef | null;
      expect(parent).not.toBeNull();
      if (parent === null) {
        throw new Error('expected ParentWithDynamicRef');
      }

      // Ref is bound
      expect(parent.ref1.current).toBeInstanceOf(Child);

      // Remove ref
      await runtime.reconcile(h(ParentWithDynamicRef, { hasRef: false, refId: 1 }));

      expect(parent.ref1.current).toBeNull();

      await runtime.unmount();
    });

    it('REF-REPLACE: replacing a ref clears the old ref and binds the new one', async () => {
      const runtime = await GraphRuntime.mount(h(ParentWithDynamicRef, { hasRef: true, refId: 1 }));
      const parent = runtime.getRootInstance() as ParentWithDynamicRef | null;
      expect(parent).not.toBeNull();
      if (parent === null) {
        throw new Error('expected ParentWithDynamicRef');
      }

      // ref1 is bound
      expect(parent.ref1.current).toBeInstanceOf(Child);
      expect(parent.ref2.current).toBeNull();

      const oldInstance = parent.ref1.current;

      // Replace ref1 with ref2
      await runtime.reconcile(h(ParentWithDynamicRef, { hasRef: true, refId: 2 }));

      // ref1 is cleared, ref2 is bound to the same instance (UPDATE path)
      expect(parent.ref1.current).toBeNull();
      expect(parent.ref2.current).toBeInstanceOf(Child);
      expect(parent.ref2.current).toBe(oldInstance);

      await runtime.unmount();
    });
  });

  describe('REF-FAILED-MOUNT: failed startup after binding', () => {
    it('REF-FAILED-MOUNT: ref is cleared after failed mount', async () => {
      const testRef: RefObject<FailingChild> = { current: null };

      class Parent extends Component<Record<string, never>, Record<string, never>> {
        public override compose (): VirtualServiceNode[] {
          return [h(FailingChild, { shouldFail: true }, testRef)];
        }
      }

      let error: Error | null = null;
      try {
        await GraphRuntime.mount(h(Parent));
      } catch (err) {
        error = err as Error;
      }

      expect(error).not.toBeNull();
      expect(error?.message).toBe('FailingChild onMount error');
      // Ref must be cleared after rollback
      expect(testRef.current).toBeNull();
    });
  });

  describe('REF-KEYED-REUSE: keyed reuse with changed ref', () => {
    class KeyedChild extends Component<Record<string, never>, { id: string }> {
      public value = 100;

      constructor (props: { id: string }) {
        super(props);
        this.state = {};
      }
    }

    class ParentWithKeyedChildren extends Component<Record<string, never>, { useRef1: boolean }> {
      public ref1: RefObject<KeyedChild> = { current: null };
      public ref2: RefObject<KeyedChild> = { current: null };

      public override compose (): VirtualServiceNode[] {
        const ref = this.props.useRef1 ? this.ref1 : this.ref2;
        return [h(KeyedChild, { id: 'keyed', key: 'child-key' }, ref)];
      }
    }

    it('REF-KEYED-SWAP: keyed child keeps same instance, ref swap clears old ref', async () => {
      const runtime = await GraphRuntime.mount(h(ParentWithKeyedChildren, { useRef1: true }));
      const parent = runtime.getRootInstance() as ParentWithKeyedChildren | null;
      expect(parent).not.toBeNull();
      if (parent === null) {
        throw new Error('expected ParentWithKeyedChildren');
      }

      // ref1 is bound
      expect(parent.ref1.current).toBeInstanceOf(KeyedChild);
      expect(parent.ref2.current).toBeNull();

      const instance = parent.ref1.current;

      // Swap to ref2 (same key → UPDATE path, same instance)
      await runtime.reconcile(h(ParentWithKeyedChildren, { useRef1: false }));

      // ref1 is cleared, ref2 is bound to the same instance
      expect(parent.ref1.current).toBeNull();
      expect(parent.ref2.current).toBe(instance);

      await runtime.unmount();
    });
  });

  describe('REF-SYMBOL-STORAGE: symbol property refs', () => {
    it('REF-SYMBOL-PROPERTY: @UseRef works with symbol property keys', async () => {
      const symbolKey = Symbol('childRef');

      class ParentWithSymbolRef extends Component<Record<string, never>, Record<string, never>> {
        @UseRef()
        public declare [symbolKey]: RefObject<Child>;

        public override compose (): VirtualServiceNode[] {
          return [h(Child, { id: 'symbol-child' }, this[symbolKey])];
        }
      }

      const runtime = await GraphRuntime.mount(h(ParentWithSymbolRef));
      const parent = runtime.getRootInstance() as ParentWithSymbolRef | null;
      expect(parent).not.toBeNull();
      if (parent === null) {
        throw new Error('expected ParentWithSymbolRef');
      }

      expect(parent[symbolKey].current).toBeInstanceOf(Child);
      expect(parent[symbolKey].current?.props.id).toBe('symbol-child');

      await runtime.unmount();
    });
  });

  describe('REF-COLLISION-PREVENTION: user property collision', () => {
    it('REF-NO-COLLISION: user property does not collide with ref storage', async () => {
      class ParentWithUserProperty extends Component<Record<string, never>, Record<string, never>> {
        // User property that would collide with old string-based storage
        public __ref_childRef = 'user-value';

        @UseRef()
        public declare childRef: RefObject<Child>;

        public override compose (): VirtualServiceNode[] {
          return [h(Child, { id: 'no-collision' }, this.childRef)];
        }
      }

      const runtime = await GraphRuntime.mount(h(ParentWithUserProperty));
      const parent = runtime.getRootInstance() as ParentWithUserProperty | null;
      expect(parent).not.toBeNull();
      if (parent === null) {
        throw new Error('expected ParentWithUserProperty');
      }

      // User property is unaffected
      expect(parent.__ref_childRef).toBe('user-value');

      // Ref still works (uses symbol storage, not string key)
      expect(parent.childRef.current).toBeInstanceOf(Child);
      expect(parent.childRef.current?.props.id).toBe('no-collision');

      await runtime.unmount();
    });

    it('REF-MULTIPLE-REFS: multiple @UseRef decorators use independent storage', async () => {
      class ParentWithMultipleRefs extends Component<Record<string, never>, Record<string, never>> {
        @UseRef()
        public declare ref1: RefObject<Child>;

        @UseRef()
        public declare ref2: RefObject<Child>;

        public override compose (): VirtualServiceNode[] {
          return [
            h(Child, { id: 'child1' }, this.ref1),
            h(Child, { id: 'child2' }, this.ref2),
          ];
        }
      }

      const runtime = await GraphRuntime.mount(h(ParentWithMultipleRefs));
      const parent = runtime.getRootInstance() as ParentWithMultipleRefs | null;
      expect(parent).not.toBeNull();
      if (parent === null) {
        throw new Error('expected ParentWithMultipleRefs');
      }

      expect(parent.ref1.current).toBeInstanceOf(Child);
      expect(parent.ref1.current?.props.id).toBe('child1');

      expect(parent.ref2.current).toBeInstanceOf(Child);
      expect(parent.ref2.current?.props.id).toBe('child2');

      // Refs are independent
      expect(parent.ref1.current).not.toBe(parent.ref2.current);

      await runtime.unmount();
    });
  });
});
