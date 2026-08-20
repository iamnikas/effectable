/**
 * Inheritance tests for @UseContext and @UseRef/@UseImperativeHandle decorators.
 * Ensures proper metadata isolation between base and derived classes.
 *
 * @module Effectable/component/context-refs-inheritance.test
 */

import {
  Component,
  UseContext,
  UseImperativeHandle,
  UseRef,
  createContext,
  getContextFields,
  getImperativeHandleMethods,
  getRefFields,
} from 'Effectable';
import type { RefObject } from 'Effectable';

const TEST_CONTEXT_A = createContext<string>('TEST_CONTEXT_A', 'default-a');
const TEST_CONTEXT_B = createContext<number>('TEST_CONTEXT_B', 42);
const TEST_CONTEXT_C = createContext<boolean>('TEST_CONTEXT_C');

describe('Context decorator inheritance', () => {
  it('parent metadata not mutated after subclass decorators', () => {
    class Base extends Component<Record<string, unknown>, Record<string, unknown>> {
      @UseContext(TEST_CONTEXT_A)
      protected contextA!: string;

      public override compose (): null {
        return null;
      }
    }

    class Derived extends Base {
      @UseContext(TEST_CONTEXT_B)
      protected contextB!: number;
    }

    const baseFields = getContextFields(Base as any);
    const derivedFields = getContextFields(Derived as any);

    expect(baseFields.length).toBe(1);
    expect(baseFields[0]?.propertyKey).toBe('contextA');

    expect(derivedFields.length).toBe(2);
    expect(derivedFields.find((f) => f.propertyKey === 'contextA')).toBeDefined();
    expect(derivedFields.find((f) => f.propertyKey === 'contextB')).toBeDefined();
  });

  it('siblings do not share metadata', () => {
    class Base extends Component<Record<string, unknown>, Record<string, unknown>> {
      @UseContext(TEST_CONTEXT_A)
      protected contextA!: string;

      public override compose (): null {
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

    const fieldsA = getContextFields(SiblingA as any);
    const fieldsB = getContextFields(SiblingB as any);

    expect(fieldsA.length).toBe(2);
    expect(fieldsA.find((f) => f.propertyKey === 'contextA')).toBeDefined();
    expect(fieldsA.find((f) => f.propertyKey === 'contextB')).toBeDefined();
    expect(fieldsA.find((f) => f.propertyKey === 'contextC')).toBeUndefined();

    expect(fieldsB.length).toBe(2);
    expect(fieldsB.find((f) => f.propertyKey === 'contextA')).toBeDefined();
    expect(fieldsB.find((f) => f.propertyKey === 'contextC')).toBeDefined();
    expect(fieldsB.find((f) => f.propertyKey === 'contextB')).toBeUndefined();
  });

  it('three-level context inheritance', () => {
    class GrandParent extends Component<Record<string, unknown>, Record<string, unknown>> {
      @UseContext(TEST_CONTEXT_A)
      public contextA!: string;

      public override compose (): null {
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

    const fields = getContextFields(Child as any);
    expect(fields.length).toBe(3);
    expect(fields.find((f) => f.propertyKey === 'contextA')).toBeDefined();
    expect(fields.find((f) => f.propertyKey === 'contextB')).toBeDefined();
    expect(fields.find((f) => f.propertyKey === 'contextC')).toBeDefined();
  });
});

describe('Refs decorator inheritance', () => {
  it('parent metadata not mutated after subclass decorators', () => {
    class Base extends Component<Record<string, unknown>, Record<string, unknown>> {
      @UseRef()
      public declare refA: RefObject<Component>;

      public override compose (): null {
        return null;
      }
    }

    class Derived extends Base {
      @UseRef()
      public declare refB: RefObject<Component>;
    }

    const baseFields = getRefFields(Base as any);
    const derivedFields = getRefFields(Derived as any);

    expect(baseFields.length).toBe(1);
    expect(baseFields[0]?.propertyKey).toBe('refA');

    expect(derivedFields.length).toBe(2);
    expect(derivedFields.find((f) => f.propertyKey === 'refA')).toBeDefined();
    expect(derivedFields.find((f) => f.propertyKey === 'refB')).toBeDefined();
  });

  it('siblings do not share ref metadata', () => {
    class Base extends Component<Record<string, unknown>, Record<string, unknown>> {
      @UseRef()
      public declare refBase: RefObject<Component>;

      public override compose (): null {
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

    const fieldsA = getRefFields(SiblingA as any);
    const fieldsB = getRefFields(SiblingB as any);

    expect(fieldsA.length).toBe(2);
    expect(fieldsA.find((f) => f.propertyKey === 'refBase')).toBeDefined();
    expect(fieldsA.find((f) => f.propertyKey === 'refA')).toBeDefined();
    expect(fieldsA.find((f) => f.propertyKey === 'refB')).toBeUndefined();

    expect(fieldsB.length).toBe(2);
    expect(fieldsB.find((f) => f.propertyKey === 'refBase')).toBeDefined();
    expect(fieldsB.find((f) => f.propertyKey === 'refB')).toBeDefined();
    expect(fieldsB.find((f) => f.propertyKey === 'refA')).toBeUndefined();
  });

  it('three-level ref and imperative handle inheritance', () => {
    class GrandParent extends Component<Record<string, unknown>, Record<string, unknown>> {
      @UseRef()
      public declare refGrandParent: RefObject<Component>;

      @UseImperativeHandle()
      public grandParentMethod (): string {
        return 'grandparent';
      }

      public override compose (): null {
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

    const refs = getRefFields(Child as any);
    expect(refs.length).toBe(3);
    expect(refs.find((r) => r.propertyKey === 'refGrandParent')).toBeDefined();
    expect(refs.find((r) => r.propertyKey === 'refParent')).toBeDefined();
    expect(refs.find((r) => r.propertyKey === 'refChild')).toBeDefined();

    const methods = getImperativeHandleMethods(Child as any);
    expect(methods.length).toBe(3);
    expect(methods.find((m) => m.methodKey === 'grandParentMethod')).toBeDefined();
    expect(methods.find((m) => m.methodKey === 'parentMethod')).toBeDefined();
    expect(methods.find((m) => m.methodKey === 'childMethod')).toBeDefined();
  });
});
