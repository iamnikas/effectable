/**
 * Inheritance tests for @UseContext and @UseRef/@UseImperativeHandle decorators.
 * Ensures proper metadata isolation between base and derived classes.
 *
 * @module Effectable/component/context-refs-inheritance.test
 */

import {
  Component,
  ContextProvider,
  GraphRuntime,
  UseContext,
  UseImperativeHandle,
  UseRef,
  createContext,
  getContextFields,
  getImperativeHandleMethods,
  getRefFields,
  h,
} from 'Effectable';
import type { RefObject } from 'Effectable';

const TEST_CONTEXT_A = createContext<string>('TEST_CONTEXT_A', 'default-a');
const TEST_CONTEXT_B = createContext<number>('TEST_CONTEXT_B', 42);
const TEST_CONTEXT_C = createContext<boolean>('TEST_CONTEXT_C');

describe('Context decorator inheritance', () => {
  describe('@UseContext metadata isolation', () => {
    it('should not mutate parent class context metadata', () => {
      class Base extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseContext(TEST_CONTEXT_A)
        protected contextA!: string;

        public compose (): null {
          return null;
        }
      }

      class Derived extends Base {
        @UseContext(TEST_CONTEXT_B)
        protected contextB!: number;
      }

      const baseFields = getContextFields(Base);
      const derivedFields = getContextFields(Derived);

      expect(baseFields.length).toBe(1);
      expect(baseFields[0]?.propertyKey).toBe('contextA');

      expect(derivedFields.length).toBe(2);
      expect(derivedFields.find((f) => f.propertyKey === 'contextA')).toBeDefined();
      expect(derivedFields.find((f) => f.propertyKey === 'contextB')).toBeDefined();

      expect(Object.isFrozen(baseFields)).toBe(true);
      expect(Object.isFrozen(derivedFields)).toBe(true);
    });

    it('should inject context values from both base and derived', async () => {
      class Base extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseContext(TEST_CONTEXT_A)
        public contextA!: string;

        public compose (): null {
          return null;
        }
      }

      class Derived extends Base {
        @UseContext(TEST_CONTEXT_B)
        public contextB!: number;
      }

      const rootNode = h(ContextProvider, {
        value: [
          [TEST_CONTEXT_A, 'test-value'],
          [TEST_CONTEXT_B, 99],
        ],
      }, [h(Derived, {})]);

      const runtime = await GraphRuntime.mount(rootNode);

      const instances = runtime.getAll(Derived);
      expect(instances.length).toBe(1);

      const instance = instances[0] as Derived;
      expect(instance.contextA).toBe('test-value');
      expect(instance.contextB).toBe(99);

      await runtime.unmount();
    });

    it('should not share metadata between siblings', () => {
      class Base extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseContext(TEST_CONTEXT_A)
        protected contextA!: string;

        public compose (): null {
          return null;
        }
      }

      class SiblingA extends Base {
        @UseContext(TEST_CONTEXT_B)
        protected contextB!: number;
      }

      class SiblingB extends Base {
        @UseContext(TEST_CONTEXT_C)
        protected contextC!: boolean;
      }

      const fieldsA = getContextFields(SiblingA);
      const fieldsB = getContextFields(SiblingB);

      expect(fieldsA.length).toBe(2);
      expect(fieldsA.find((f) => f.propertyKey === 'contextA')).toBeDefined();
      expect(fieldsA.find((f) => f.propertyKey === 'contextB')).toBeDefined();
      expect(fieldsA.find((f) => f.propertyKey === 'contextC')).toBeUndefined();

      expect(fieldsB.length).toBe(2);
      expect(fieldsB.find((f) => f.propertyKey === 'contextA')).toBeDefined();
      expect(fieldsB.find((f) => f.propertyKey === 'contextC')).toBeDefined();
      expect(fieldsB.find((f) => f.propertyKey === 'contextB')).toBeUndefined();
    });
  });

  describe('multi-level inheritance', () => {
    it('should handle three-level context inheritance', async () => {
      class GrandParent extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseContext(TEST_CONTEXT_A)
        public contextA!: string;

        public compose (): null {
          return null;
        }
      }

      class Parent extends GrandParent {
        @UseContext(TEST_CONTEXT_B)
        public contextB!: number;
      }

      class Child extends Parent {
        @UseContext(TEST_CONTEXT_C)
        public contextC!: boolean;
      }

      const fields = getContextFields(Child);
      expect(fields.length).toBe(3);
      expect(fields.find((f) => f.propertyKey === 'contextA')).toBeDefined();
      expect(fields.find((f) => f.propertyKey === 'contextB')).toBeDefined();
      expect(fields.find((f) => f.propertyKey === 'contextC')).toBeDefined();

      const rootNode = h(ContextProvider, {
        value: [
          [TEST_CONTEXT_A, 'test'],
          [TEST_CONTEXT_B, 100],
          [TEST_CONTEXT_C, true],
        ],
      }, [h(Child, {})]);

      const runtime = await GraphRuntime.mount(rootNode);

      const instances = runtime.getAll(Child);
      const instance = instances[0] as Child;

      expect(instance.contextA).toBe('test');
      expect(instance.contextB).toBe(100);
      expect(instance.contextC).toBe(true);

      await runtime.unmount();
    });
  });

  describe('getContextFields returns frozen array', () => {
    it('should return frozen array that cannot be mutated', () => {
      class TestComponent extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseContext(TEST_CONTEXT_A)
        public contextA!: string;

        public compose (): null {
          return null;
        }
      }

      const fields = getContextFields(TestComponent);
      expect(Object.isFrozen(fields)).toBe(true);

      expect(() => {
        (fields as unknown[]).push({ propertyKey: 'fake', token: TEST_CONTEXT_B });
      }).toThrow();
    });
  });
});

describe('Refs decorator inheritance', () => {
  describe('@UseRef metadata isolation', () => {
    it('should not mutate parent class ref metadata', () => {
      class Base extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseRef()
        public declare refA: RefObject<Component>;

        public compose (): null {
          return null;
        }
      }

      class Derived extends Base {
        @UseRef()
        public declare refB: RefObject<Component>;
      }

      const baseFields = getRefFields(Base);
      const derivedFields = getRefFields(Derived);

      expect(baseFields.length).toBe(1);
      expect(baseFields[0]?.propertyKey).toBe('refA');

      expect(derivedFields.length).toBe(2);
      expect(derivedFields.find((f) => f.propertyKey === 'refA')).toBeDefined();
      expect(derivedFields.find((f) => f.propertyKey === 'refB')).toBeDefined();

      expect(Object.isFrozen(baseFields)).toBe(true);
      expect(Object.isFrozen(derivedFields)).toBe(true);
    });

    it('should not share ref metadata between siblings', () => {
      class Base extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseRef()
        public declare refBase: RefObject<Component>;

        public compose (): null {
          return null;
        }
      }

      class SiblingA extends Base {
        @UseRef()
        public declare refA: RefObject<Component>;
      }

      class SiblingB extends Base {
        @UseRef()
        public declare refB: RefObject<Component>;
      }

      const fieldsA = getRefFields(SiblingA);
      const fieldsB = getRefFields(SiblingB);

      expect(fieldsA.length).toBe(2);
      expect(fieldsA.find((f) => f.propertyKey === 'refBase')).toBeDefined();
      expect(fieldsA.find((f) => f.propertyKey === 'refA')).toBeDefined();
      expect(fieldsA.find((f) => f.propertyKey === 'refB')).toBeUndefined();

      expect(fieldsB.length).toBe(2);
      expect(fieldsB.find((f) => f.propertyKey === 'refBase')).toBeDefined();
      expect(fieldsB.find((f) => f.propertyKey === 'refB')).toBeDefined();
      expect(fieldsB.find((f) => f.propertyKey === 'refA')).toBeUndefined();
    });
  });

  describe('@UseImperativeHandle metadata isolation', () => {
    it('should not mutate parent class imperative handle metadata', () => {
      class Base extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseImperativeHandle()
        public methodA (): string {
          return 'a';
        }

        public compose (): null {
          return null;
        }
      }

      class Derived extends Base {
        @UseImperativeHandle()
        public methodB (): string {
          return 'b';
        }
      }

      const baseMethods = getImperativeHandleMethods(Base);
      const derivedMethods = getImperativeHandleMethods(Derived);

      expect(baseMethods.length).toBe(1);
      expect(baseMethods[0]?.methodKey).toBe('methodA');

      expect(derivedMethods.length).toBe(2);
      expect(derivedMethods.find((m) => m.methodKey === 'methodA')).toBeDefined();
      expect(derivedMethods.find((m) => m.methodKey === 'methodB')).toBeDefined();

      expect(Object.isFrozen(baseMethods)).toBe(true);
      expect(Object.isFrozen(derivedMethods)).toBe(true);
    });

    it('should not share imperative handle metadata between siblings', () => {
      class Base extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseImperativeHandle()
        public baseMethod (): string {
          return 'base';
        }

        public compose (): null {
          return null;
        }
      }

      class SiblingA extends Base {
        @UseImperativeHandle()
        public methodA (): string {
          return 'a';
        }
      }

      class SiblingB extends Base {
        @UseImperativeHandle()
        public methodB (): string {
          return 'b';
        }
      }

      const methodsA = getImperativeHandleMethods(SiblingA);
      const methodsB = getImperativeHandleMethods(SiblingB);

      expect(methodsA.length).toBe(2);
      expect(methodsA.find((m) => m.methodKey === 'baseMethod')).toBeDefined();
      expect(methodsA.find((m) => m.methodKey === 'methodA')).toBeDefined();
      expect(methodsA.find((m) => m.methodKey === 'methodB')).toBeUndefined();

      expect(methodsB.length).toBe(2);
      expect(methodsB.find((m) => m.methodKey === 'baseMethod')).toBeDefined();
      expect(methodsB.find((m) => m.methodKey === 'methodB')).toBeDefined();
      expect(methodsB.find((m) => m.methodKey === 'methodA')).toBeUndefined();
    });
  });

  describe('multi-level inheritance', () => {
    it('should handle three-level ref inheritance', () => {
      class GrandParent extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseRef()
        public declare refGrandParent: RefObject<Component>;

        @UseImperativeHandle()
        public grandParentMethod (): string {
          return 'grandparent';
        }

        public compose (): null {
          return null;
        }
      }

      class Parent extends GrandParent {
        @UseRef()
        public declare refParent: RefObject<Component>;

        @UseImperativeHandle()
        public parentMethod (): string {
          return 'parent';
        }
      }

      class Child extends Parent {
        @UseRef()
        public declare refChild: RefObject<Component>;

        @UseImperativeHandle()
        public childMethod (): string {
          return 'child';
        }
      }

      const refs = getRefFields(Child);
      expect(refs.length).toBe(3);
      expect(refs.find((r) => r.propertyKey === 'refGrandParent')).toBeDefined();
      expect(refs.find((r) => r.propertyKey === 'refParent')).toBeDefined();
      expect(refs.find((r) => r.propertyKey === 'refChild')).toBeDefined();

      const methods = getImperativeHandleMethods(Child);
      expect(methods.length).toBe(3);
      expect(methods.find((m) => m.methodKey === 'grandParentMethod')).toBeDefined();
      expect(methods.find((m) => m.methodKey === 'parentMethod')).toBeDefined();
      expect(methods.find((m) => m.methodKey === 'childMethod')).toBeDefined();
    });
  });

  describe('getters return frozen arrays', () => {
    it('getRefFields should return frozen array', () => {
      class TestComponent extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseRef()
        public declare ref: RefObject<Component>;

        public compose (): null {
          return null;
        }
      }

      const fields = getRefFields(TestComponent);
      expect(Object.isFrozen(fields)).toBe(true);

      expect(() => {
        (fields as unknown[]).push({ propertyKey: 'fake' });
      }).toThrow();
    });

    it('getImperativeHandleMethods should return frozen array', () => {
      class TestComponent extends Component<Record<string, unknown>, Record<string, unknown>> {
        @UseImperativeHandle()
        public method (): void {
          // test method
        }

        public compose (): null {
          return null;
        }
      }

      const methods = getImperativeHandleMethods(TestComponent);
      expect(Object.isFrozen(methods)).toBe(true);

      expect(() => {
        (methods as unknown[]).push({ methodKey: 'fake' });
      }).toThrow();
    });
  });
});
