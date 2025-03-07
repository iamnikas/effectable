/**
 * @fileoverview
 * Provides the `@Watched` decorator, which marks a field for reactive handling.
 */

const watchedFieldsMap = new WeakMap<Function, string[]>();

/**
 * Marks a class field as watched. This means it will be handled as a reactive field.
 * The actual logic of get/set is applied in the constructor of the base module class.
 * @param target The prototype of the class.
 * @param propertyKey The name of the field being decorated.
 */
export function Watched(target: any, propertyKey: string): void {
  const ctor = target.constructor;
  if (!watchedFieldsMap.has(ctor)) {
    watchedFieldsMap.set(ctor, []);
  }
  watchedFieldsMap.get(ctor)!.push(propertyKey);
}

/**
 * Retrieves the watched fields for a given class constructor.
 * @param ctor The constructor (class) to look up.
 * @returns An array of field names that were marked with @Watched.
 */
export function getWatchedFields(ctor: Function): string[] {
  return watchedFieldsMap.get(ctor) || [];
}
