/**
 * @fileoverview
 * Jest unit tests for the Effectable library (ReactiveModule + @Watched).
 * Covers both positive (successful) and negative test cases.
 */

import { ReactiveModule, Watched } from '../src'; // Adjust the import if needed

/**
 * A sample module for testing. We'll override moduleDidUpdate for assertions.
 */
class TestModule extends ReactiveModule {
  @Watched
  public count: number = 0;

  @Watched
  public message: string = 'Hello';

  public updatedKeysLog: string[] = [];

  /**
   * Overridden lifecycle method to track updated fields.
   * @param prevState A snapshot of previous values
   * @param updatedKeys The list of fields that changed
   */
  public moduleDidUpdate(prevState: Record<string, any>, updatedKeys: string[]): void {
    this.updatedKeysLog = updatedKeys;
  }
}

describe('Effectable Library (ReactiveModule + @Watched)', () => {
  /**
   * Positive test:
   * Should initialize fields with their default values.
   */
  it('should initialize @Watched fields with default values', () => {
    const mod = new TestModule();
    expect(mod.count).toBe(0);
    expect(mod.message).toBe('Hello');
    // No update calls yet, so updatedKeysLog should be empty
    expect(mod.updatedKeysLog).toEqual([]);
  });

  /**
   * Positive test:
   * setState should update fields, trigger moduleDidUpdate, and reflect changes.
   */
  it('should update fields via setState and call moduleDidUpdate', () => {
    const mod = new TestModule();
    // Initially count=0, message='Hello'
    mod.setState({ count: 10 });

    expect(mod.count).toBe(10);
    // We expect updatedKeysLog to show ['count']
    expect(mod.updatedKeysLog).toEqual(['count']);

    // Check that other fields remain unchanged
    expect(mod.message).toBe('Hello');
  });

  /**
   * Positive test:
   * setState should be able to update multiple fields in one call.
   */
  it('should update multiple fields in one setState call', () => {
    const mod = new TestModule();
    mod.setState({ count: 5, message: 'World' });

    expect(mod.count).toBe(5);
    expect(mod.message).toBe('World');
    // updatedKeysLog should contain both fields
    expect(mod.updatedKeysLog.sort()).toEqual(['count', 'message'].sort());
  });

  /**
   * Positive test:
   * Calling setState with no actual changes should NOT trigger moduleDidUpdate.
   */
  it('should not trigger moduleDidUpdate if no changes occur', () => {
    const mod = new TestModule();
    // setState with the same values => no real change
    mod.setState({ count: 0, message: 'Hello' });

    // Since fields remain the same, updatedKeysLog should still be empty
    expect(mod.updatedKeysLog).toEqual([]);
  });

  /**
   * Negative test:
   * Direct assignment to a @Watched field should throw an error.
   */
  it('should throw an error when directly assigning to a @Watched field', () => {
    const mod = new TestModule();
    // Attempt to assign directly
    expect(() => {
      (mod as any).count = 999; // forced cast to bypass TS error
    }).toThrowError(/not allowed\. Use setState/);
  });

  /**
   * Negative test:
   * If a setState call tries to partially update a field to the same value, it should not cause double updates.
   */
  it('should only update changed fields, ignoring unchanged fields in setState', () => {
    const mod = new TestModule();
    // First update: count from 0 to 1, message from 'Hello' to 'Hello' (no change)
    mod.setState({ count: 1, message: 'Hello' });

    expect(mod.count).toBe(1);
    // updatedKeysLog should contain only 'count'
    expect(mod.updatedKeysLog).toEqual(['count']);

    // Now updatedKeysLog is cleared for next step
    mod.updatedKeysLog = [];

    // Second update: no changes at all
    mod.setState({ count: 1, message: 'Hello' });
    // No update => no changes => updatedKeysLog remains empty
    expect(mod.updatedKeysLog).toEqual([]);
  });

  /**
   * Negative test:
   * Attempting to change a non-existent field in setState should not break anything,
   * but it also won't be tracked by @Watched.
   */
  it('should ignore non-existent fields in setState (not @Watched)', () => {
    const mod = new TestModule();
    mod.setState({ someRandomField: 123 });

    // Since "someRandomField" is not watched, updatedKeysLog should remain empty
    expect(mod.updatedKeysLog).toEqual([]);
    // The field does not exist, so it won't appear in the object
    expect((mod as any).someRandomField).toBeUndefined();
  });
});
