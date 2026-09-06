/**
 * Regression: createSelector memoization must treat stable NaN as equal.
 *
 * `shallowEqual` used `===` / `!==`, so an input selector returning NaN always
 * looked "changed". Combiners that allocate a new object then broke referential
 * stability; a `store.select` subscriber that dispatches on notify livelocks.
 *
 * Distinct from createStore.select's distinctUntilChanged NaN fix: even with
 * Object.is there, a new `{ score: NaN }` each emission still notifies.
 */
import { createSelector, createStore } from 'Effectable';

type ScoreState = { score: number; tick: number };

describe('createSelector shallowEqual + stable NaN', () => {
  it('does not recompute when an input selector returns stable NaN', () => {
    const selectScoreBox = createSelector(
      (s: ScoreState) => s.score,
      (score) => ({ score }),
    );

    const first = selectScoreBox({ score: NaN, tick: 0 });
    const second = selectScoreBox({ score: NaN, tick: 1 });

    expect(Number.isNaN(first.score)).toBe(true);
    expect(selectScoreBox.recomputations()).toBe(1);
    expect(second).toBe(first);
  });

  it('does not recompute when NaN deps are unchanged across calls', () => {
    const selectFromNaNField = createSelector(
      [(s: ScoreState) => s.score, (s: ScoreState) => s.tick],
      (score, tick) => ({ score, tick }),
    );

    const a = selectFromNaNField({ score: NaN, tick: 1 });
    const b = selectFromNaNField({ score: NaN, tick: 1 });
    expect(selectFromNaNField.recomputations()).toBe(1);
    expect(b).toBe(a);

    const c = selectFromNaNField({ score: NaN, tick: 2 });
    expect(selectFromNaNField.recomputations()).toBe(2);
    expect(c).not.toBe(a);
  });

  it('store.select(createSelector) does not livelock when score stays NaN', () => {
    const store = createStore(
      (
        state: ScoreState | undefined,
        action: { type: string },
      ): ScoreState => {
        const prev = state ?? { score: NaN, tick: 0 };
        if (action.type === 'TICK') {
          return { score: prev.score, tick: prev.tick + 1 };
        }
        return prev;
      },
      { score: NaN, tick: 0 },
    );

    const selectScoreBox = createSelector(
      (s: ScoreState) => s.score,
      (score) => ({ score }),
    );

    let notifications = 0;
    const subscription = store.select(selectScoreBox).subscribe(() => {
      notifications += 1;
      if (notifications > 25) {
        subscription.unsubscribe();
        throw new Error('livelock: select notified too many times for stable NaN');
      }
      // Mimic a UI that writes back on every selected emission.
      if (notifications > 1) {
        store.dispatch({ type: 'TICK' });
      }
    });

    store.dispatch({ type: 'TICK' });

    // Initial BehaviorSubject emission + at most one notify from TICK before
    // memoized identity suppresses further cascades.
    expect(notifications).toBeLessThan(10);
    expect(selectScoreBox.recomputations()).toBe(1);
    subscription.unsubscribe();
    store.destroy();
  });
});
