import { createStore } from '../src/store/createStore';

describe('createStore.select NaN distinctUntilChanged', () => {
  it('does not re-emit when selector keeps returning NaN', () => {
    const store = createStore(
      (s: { n: number } = { n: NaN }, a: { type: string; n?: number }) => {
        if (a.type === 'SET') return { n: a.n as number };
        return s;
      },
      { n: NaN },
    );
    let emissions = 0;
    store.select((s) => s.n).subscribe((n) => {
      emissions += 1;
      if (emissions > 5) {
        throw new Error('NaN select re-entered too many times');
      }
      // Classic footgun: subscriber "normalizes" NaN by dispatching NaN again
      if (Number.isNaN(n)) {
        store.dispatch({ type: 'SET', n: NaN });
      }
    });
    // BehaviorSubject emits initial NaN once; without Object.is, distinctUntilChanged
    // sees NaN !== NaN and each dispatch re-emits → unbounded loop.
    expect(emissions).toBe(1);
    store.destroy();
  });
});
