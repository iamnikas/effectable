/**
 * Inheritance tests for HandleRegistry decorators (@forwardRef, @UseRef, @UseImperativeHandle).
 * Ensures proper metadata isolation between base and derived classes.
 *
 * @module Effectable/runtime/HandleRegistry.inheritance.test
 */

import {
  HandleRegistry,
  UseImperativeHandle as HandleRegistryUseImperativeHandle,
  UseRef as HandleRegistryUseRef,
  forwardRef,
} from 'Effectable';

describe('HandleRegistry decorator inheritance', () => {
  describe('@forwardRef class decorator', () => {
    it('should not share metadata between parent and child', () => {
      @forwardRef('base-key')
      class Base {
        @HandleRegistryUseRef()
        public ref = {};

        @HandleRegistryUseImperativeHandle()
        public baseMethod (): string {
          return 'base';
        }
      }

      @forwardRef('derived-key')
      class Derived extends Base {
        @HandleRegistryUseImperativeHandle()
        public derivedMethod (): string {
          return 'derived';
        }
      }

      const registry = new HandleRegistry();
      const baseInstance = new Base();
      const derivedInstance = new Derived();

      const disposeBase = registry.autoRegister(baseInstance);
      const disposeDerived = registry.autoRegister(derivedInstance);

      const baseHandle = registry.get<{ baseMethod: () => string }>('base-key');
      const derivedHandle = registry.get<{ baseMethod: () => string; derivedMethod: () => string }>('derived-key');

      expect(baseHandle?.baseMethod()).toBe('base');
      expect((baseHandle as Record<string, unknown>)?.derivedMethod).toBeUndefined();

      expect(derivedHandle?.baseMethod()).toBe('base');
      expect(derivedHandle?.derivedMethod()).toBe('derived');

      disposeBase();
      disposeDerived();
    });

    it('should allow child class to override forwardRef key', () => {
      @forwardRef('base-key')
      class Base {
        @HandleRegistryUseRef()
        public ref = {};

        @HandleRegistryUseImperativeHandle()
        public method (): string {
          return 'base';
        }
      }

      @forwardRef('child-key')
      class Child extends Base {}

      const registry = new HandleRegistry();
      const childInstance = new Child();
      const dispose = registry.autoRegister(childInstance);

      expect(registry.has('child-key')).toBe(true);
      expect(registry.has('base-key')).toBe(false);

      dispose();
    });

    it('should allow child to use factory function for key', () => {
      @forwardRef('base-key')
      class Base {
        @HandleRegistryUseRef()
        public ref = {};

        @HandleRegistryUseImperativeHandle()
        public method (): string {
          return 'base';
        }
      }

      @forwardRef((instance: { id: string }) => `child-${instance.id}`)
      class Child extends Base {
        public id: string;
        constructor (id: string) {
          super();
          this.id = id;
        }
      }

      const registry = new HandleRegistry();
      const child1 = new Child('1');
      const child2 = new Child('2');

      const dispose1 = registry.autoRegister(child1);
      const dispose2 = registry.autoRegister(child2);

      expect(registry.has('child-1')).toBe(true);
      expect(registry.has('child-2')).toBe(true);

      dispose1();
      dispose2();
    });
  });

  describe('@UseImperativeHandle method decorator', () => {
    it('should collect methods from both base and derived', () => {
      @forwardRef('test-key')
      class Base {
        @HandleRegistryUseRef()
        public ref = {};

        @HandleRegistryUseImperativeHandle()
        public baseMethod (): string {
          return 'base';
        }
      }

      @forwardRef('test-key-derived')
      class Derived extends Base {
        @HandleRegistryUseImperativeHandle()
        public derivedMethod (): string {
          return 'derived';
        }
      }

      const registry = new HandleRegistry();
      const instance = new Derived();
      const dispose = registry.autoRegister(instance);

      const handle = registry.get<{ baseMethod: () => string; derivedMethod: () => string }>('test-key-derived');

      expect(handle?.baseMethod()).toBe('base');
      expect(handle?.derivedMethod()).toBe('derived');

      dispose();
    });

    it('should not mutate parent class metadata', () => {
      @forwardRef('base-key')
      class Base {
        @HandleRegistryUseRef()
        public ref = {};

        @HandleRegistryUseImperativeHandle()
        public baseMethod (): string {
          return 'base';
        }
      }

      @forwardRef('derived-key')
      class Derived extends Base {
        @HandleRegistryUseImperativeHandle()
        public derivedMethod (): string {
          return 'derived';
        }
      }

      const registry = new HandleRegistry();

      const baseInstance = new Base();
      const disposeBase = registry.autoRegister(baseInstance);
      const baseHandle = registry.get<{ baseMethod: () => string }>('base-key');
      expect(baseHandle?.baseMethod()).toBe('base');
      expect((baseHandle as Record<string, unknown>)?.derivedMethod).toBeUndefined();

      const derivedInstance = new Derived();
      const disposeDerived = registry.autoRegister(derivedInstance);

      const baseHandleAfter = registry.get<{ baseMethod: () => string }>('base-key');
      expect(baseHandleAfter?.baseMethod()).toBe('base');
      expect((baseHandleAfter as Record<string, unknown>)?.derivedMethod).toBeUndefined();

      disposeBase();
      disposeDerived();
    });
  });

  describe('multi-level inheritance', () => {
    it('should handle three-level inheritance', () => {
      @forwardRef('grandparent-key')
      class GrandParent {
        @HandleRegistryUseRef()
        public ref = {};

        @HandleRegistryUseImperativeHandle()
        public grandparentMethod (): string {
          return 'grandparent';
        }
      }

      @forwardRef('parent-key')
      class Parent extends GrandParent {
        @HandleRegistryUseImperativeHandle()
        public parentMethod (): string {
          return 'parent';
        }
      }

      @forwardRef('child-key')
      class Child extends Parent {
        @HandleRegistryUseImperativeHandle()
        public childMethod (): string {
          return 'child';
        }
      }

      const registry = new HandleRegistry();
      const instance = new Child();
      const dispose = registry.autoRegister(instance);

      const handle = registry.get<{
        grandparentMethod: () => string;
        parentMethod: () => string;
        childMethod: () => string;
      }>('child-key');

      expect(handle?.grandparentMethod()).toBe('grandparent');
      expect(handle?.parentMethod()).toBe('parent');
      expect(handle?.childMethod()).toBe('child');

      dispose();
    });
  });

  describe('independent sibling classes', () => {
    it('should not share metadata between siblings', () => {
      @forwardRef('base-key')
      class Base {
        @HandleRegistryUseRef()
        public ref = {};

        @HandleRegistryUseImperativeHandle()
        public baseMethod (): string {
          return 'base';
        }
      }

      @forwardRef('sibling-a-key')
      class SiblingA extends Base {
        @HandleRegistryUseImperativeHandle()
        public methodA (): string {
          return 'a';
        }
      }

      @forwardRef('sibling-b-key')
      class SiblingB extends Base {
        @HandleRegistryUseImperativeHandle()
        public methodB (): string {
          return 'b';
        }
      }

      const registry = new HandleRegistry();

      const instanceA = new SiblingA();
      const disposeA = registry.autoRegister(instanceA);
      const handleA = registry.get<{ baseMethod: () => string; methodA: () => string }>('sibling-a-key');

      expect(handleA?.baseMethod()).toBe('base');
      expect(handleA?.methodA()).toBe('a');
      expect((handleA as Record<string, unknown>)?.methodB).toBeUndefined();

      const instanceB = new SiblingB();
      const disposeB = registry.autoRegister(instanceB);
      const handleB = registry.get<{ baseMethod: () => string; methodB: () => string }>('sibling-b-key');

      expect(handleB?.baseMethod()).toBe('base');
      expect(handleB?.methodB()).toBe('b');
      expect((handleB as Record<string, unknown>)?.methodA).toBeUndefined();

      disposeA();
      disposeB();
    });
  });
});
