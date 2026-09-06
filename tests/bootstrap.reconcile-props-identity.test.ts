/**
 * Regression: BootstrapHandle.reconcile() must surface in-place mutations of
 * the closed-over props bag to GraphRuntime's referential propsChanged gate
 * (prevProps !== instance.props), so root onUpdate runs for external sources.
 */

import { Component, bootstrap } from 'Effectable';

interface ExternalProps {
  n: number;
}

interface MirrorState {
  mirrored: number;
}

class ExternalPropsRoot extends Component<MirrorState, ExternalProps> {
  public updateFromPropsCount = 0;

  constructor (props: ExternalProps) {
    super(props);
    this.state = { mirrored: props.n };
  }

  /**
   * Dual-purpose onUpdate (state via setState, props via GraphRuntime).
   * Count only props deliveries: next has `n`, not `mirrored`.
   */
  public override onUpdate (
    _prev: MirrorState | ExternalProps,
    next: MirrorState | ExternalProps
  ): void {
    if (typeof next === 'object' && next !== null && 'n' in next) {
      this.updateFromPropsCount += 1;
      // Direct write — setState would re-enter this dual-purpose onUpdate.
      this.state = { mirrored: next.n };
    }
  }

  public override compose (): null {
    return null;
  }
}

describe('bootstrap — reconcile props identity for external sources', () => {
  it('BOOT-PROPS: mutated handle.props + reconcile() invokes onUpdate and syncs state', async () => {
    const props: ExternalProps = { n: 1 };
    const handle = await bootstrap<ExternalProps, ExternalPropsRoot>(
      ExternalPropsRoot,
      props,
      { name: 'external-props-reconcile' }
    );

    expect(handle.rootInstance.state.mirrored).toBe(1);
    expect(handle.rootInstance.updateFromPropsCount).toBe(0);

    // Documented path for external reactive sources: mutate the original bag,
    // then call reconcile() (see BootstrapHandle.reconcile JSDoc).
    props.n = 2;
    await handle.reconcile();

    expect(handle.rootInstance.props.n).toBe(2);
    expect(handle.rootInstance.updateFromPropsCount).toBe(1);
    expect(handle.rootInstance.state.mirrored).toBe(2);

    await handle.shutdown();
  });
});
