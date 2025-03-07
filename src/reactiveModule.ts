/**
 * @fileoverview
 * Contains the `ReactiveModule` base class, providing reactive fields and setState logic.
 */

import { getWatchedFields } from "./watched";

/**
 * The base class for creating reactive modules.
 * It handles state updates for fields marked with `@Watched`.
 */
export class ReactiveModule {
  /**
   * Internal Map storing the actual values of watched fields.
   * Key is the field name, value is the current state.
   */
  protected _stateMap: Map<string, any> = new Map();

  /**
   * Creates an instance of ReactiveModule.
   * It automatically applies watchers to any fields decorated with `@Watched`.
   */
  constructor() {
    this.applyWatchedFields();
  }

  /**
   * Applies getters and setters on the instance for each field marked with `@Watched`.
   * This is called from the constructor. It captures any initial field values
   * and moves them into `_stateMap`.
   * @private
   */
  private applyWatchedFields(): void {
    const ctor = this.constructor;
    const fields = getWatchedFields(ctor);
    for (const fieldName of fields) {
      // Capture the initial value the field had.
      const initialVal = (this as any)[fieldName];

      // Store in _stateMap.
      this._stateMap.set(fieldName, initialVal);

      // Remove the direct property from "this", so we can redefine.
      if (Object.hasOwn(this, fieldName)) {
        delete (this as any)[fieldName];
      }

      // Define a getter and setter on the instance (not on the prototype).
      Object.defineProperty(this, fieldName, {
        configurable: true,
        enumerable: true,
        get: () => {
          return this._stateMap.get(fieldName);
        },
        set: () => {
          throw new Error(
            `Direct assignment to "${fieldName}" is not allowed. Use setState(...) instead.`
          );
        },
      });
    }
  }

  /**
   * Updates the fields in `_stateMap` in a single batch.
   * If at least one field changes, `moduleDidUpdate` is invoked.
   * @param partial An object containing key-value pairs of fields to update.
   */
  public setState(partial: Record<string, any>): void {
    const prevState: Record<string, any> = {};
    for (const [k, v] of this._stateMap.entries()) {
      prevState[k] = v;
    }

    const updatedKeys: string[] = [];
    for (const key of Object.keys(partial)) {
      const oldVal = this._stateMap.get(key);
      const newVal = partial[key];
      if (oldVal !== newVal) {
        this._stateMap.set(key, newVal);
        updatedKeys.push(key);
      }
    }

    if (updatedKeys.length > 0) {
      this.moduleDidUpdate(prevState, updatedKeys);
    }
  }

  /**
   * Called after a successful state update if any field has changed.
   * @param prevState A snapshot of the state before the update.
   * @param updatedKeys The list of fields that changed.
   */
  public moduleDidUpdate(
    prevState: Record<string, any>,
    updatedKeys: string[]
  ): void {
    // By default, does nothing. Override in a subclass if needed.
  }
}
